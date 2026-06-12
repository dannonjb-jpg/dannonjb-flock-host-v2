import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import Database from 'better-sqlite3';
import { AssetStore } from '../src/store/asset-store.js';
import { Clock, IdGen } from '../src/domain/ports.js';

// Minimal mock implementations
const mockClock: Clock = {
  nowIso: () => new Date().toISOString(),
};

const mockIdGen: IdGen = {
  next: (() => {
    let i = 0;
    return () => `asset-${++i}`;
  })(),
};

test('Asset Store — Version-at-Confirm Model', async () => {
  /**
   * CORE ASSERTION: Multiple pending images can coexist at (jid, 'unknown', version=0).
   * When confirmed, version is allocated in the target type's fidelity namespace.
   *
   * Scenario:
   * 1. Customer sends two images (both unknown type, version=0)
   * 2. Confirm first as logo → allocates version=1 in logo namespace
   * 3. Send a different logo image, confirm as logo → allocates version=2, old one cleared
   * 4. Verify resolveLogo('current') returns version 2, old is not current
   */

  // Setup: in-memory SQLite with asset schema
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE asset_bytes (
      bytes_hash TEXT PRIMARY KEY,
      content BLOB NOT NULL,
      bytes_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE assets (
      asset_id TEXT PRIMARY KEY,
      jid TEXT NOT NULL,
      bytes_hash TEXT NOT NULL REFERENCES asset_bytes(bytes_hash),
      asset_type TEXT NOT NULL DEFAULT 'unknown',
      role TEXT NOT NULL DEFAULT 'unknown',
      role_source TEXT NOT NULL DEFAULT 'proposed_unconfirmed',
      resolution_hint TEXT NOT NULL DEFAULT 'unknown',
      width_px INTEGER,
      height_px INTEGER,
      is_vector INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      source_message TEXT,
      created_at TEXT NOT NULL,
      notes TEXT,
      CHECK (asset_type IN ('logo','product','reference','unknown')),
      CHECK (role IN ('fidelity','reference','unknown','discarded')),
      CHECK (role_source IN ('client_stated','proposed_unconfirmed')),
      CHECK (resolution_hint IN ('whatsapp','vector','high_res','unknown')),
      CHECK (is_vector IN (0,1)),
      CHECK (is_current IN (0,1))
    );

    CREATE UNIQUE INDEX idx_assets_jid_bytes ON assets(jid, bytes_hash);
    CREATE UNIQUE INDEX idx_assets_current ON assets(jid, asset_type) WHERE is_current = 1;
    CREATE UNIQUE INDEX idx_assets_version ON assets(jid, asset_type, version) WHERE role = 'fidelity';
    CREATE INDEX idx_assets_jid ON assets(jid);
  `);

  const store = new AssetStore(db, mockClock, mockIdGen);
  const jid = '1234567890';

  // Step 1: Write two images (both land as pending with version=0)
  console.log('\n=== STEP 1: Write two images ===');
  const asset1Id = await store.writeAsset({
    jid,
    content: Buffer.from('image-one-bytes'),
    source_message: 'msg-1',
  });
  console.log(`Asset 1: ${asset1Id}`);

  const asset2Id = await store.writeAsset({
    jid,
    content: Buffer.from('image-two-bytes'),
    source_message: 'msg-2',
  });
  console.log(`Asset 2: ${asset2Id}`);

  // Verify both exist as pending, version=0
  let pending = store.pendingAssets(jid);
  assert.equal(pending.length, 2, 'Should have 2 pending assets');
  assert.equal(pending[0].version, 0, 'Asset 1 pending at version=0');
  assert.equal(pending[1].version, 0, 'Asset 2 pending at version=0');
  assert.equal(pending[0].asset_type, 'unknown', 'Asset 1 type is unknown');
  assert.equal(pending[1].asset_type, 'unknown', 'Asset 2 type is unknown');
  console.log(`✓ Both pending at (jid, unknown, version=0)`);

  // Step 2: Confirm first as logo → allocates version=1, promotes to current
  console.log('\n=== STEP 2: Confirm Asset 1 as logo ===');
  store.confirmAssetRole(asset1Id, 'logo', 'fidelity', true);

  let asset1 = store.resolveLogo(jid, 'current');
  assert(asset1, 'Should resolve current logo');
  assert.equal(asset1.asset_id, asset1Id, 'Current logo is asset 1');
  assert.equal(asset1.version, 1, 'Asset 1 allocated to version 1');
  assert.equal(asset1.is_current, true, 'Asset 1 is current');
  assert.equal(asset1.role, 'fidelity', 'Asset 1 role is fidelity');
  assert.equal(asset1.role_source, 'client_stated', 'Asset 1 role_source is client_stated');
  console.log(`✓ Asset 1 confirmed as logo, version=1, is_current=1`);

  // Step 3: Confirm second as logo → allocates version=2, clears asset 1 as current
  console.log('\n=== STEP 3: Confirm Asset 2 as different logo ===');
  store.confirmAssetRole(asset2Id, 'logo', 'fidelity', true);

  let asset2 = store.resolveLogo(jid, 'current');
  assert(asset2, 'Should resolve current logo');
  assert.equal(asset2.asset_id, asset2Id, 'Current logo is now asset 2');
  assert.equal(asset2.version, 2, 'Asset 2 allocated to version 2');
  assert.equal(asset2.is_current, true, 'Asset 2 is current');
  console.log(`✓ Asset 2 confirmed as logo, version=2, is_current=1`);

  // Verify asset 1 is no longer current
  const asset1ById = db.prepare(
    'SELECT is_current FROM assets WHERE asset_id = ?',
  ).get(asset1Id) as { is_current: number };
  assert.equal(asset1ById.is_current, 0, 'Asset 1 is_current cleared');
  console.log(`✓ Asset 1 is_current cleared to 0`);

  // Step 4: Verify no pending assets remain
  console.log('\n=== STEP 4: Verify no pending ===');
  pending = store.pendingAssets(jid);
  assert.equal(pending.length, 0, 'No pending assets after confirm');
  console.log(`✓ No pending assets`);

  // Step 5: Verify version uniqueness per type (logo and product are separate namespaces)
  console.log('\n=== STEP 5: Version namespaces are per-type ===');
  const asset3Id = await store.writeAsset({
    jid,
    content: Buffer.from('product-image-bytes'),
    source_message: 'msg-3',
  });
  store.confirmAssetRole(asset3Id, 'product', 'fidelity', true);

  const product = db.prepare(
    'SELECT version FROM assets WHERE asset_id = ?',
  ).get(asset3Id) as { version: number };
  assert.equal(product.version, 1, 'Product version=1 (separate from logo namespace)');
  console.log(`✓ Product logo allocated to version=1 (separate logo namespace)`);

  // Both current
  const logoCount = db.prepare(
    'SELECT COUNT(*) as c FROM assets WHERE jid = ? AND asset_type = ? AND is_current = 1',
  ).get(jid, 'logo') as { c: number };
  const productCount = db.prepare(
    'SELECT COUNT(*) as c FROM assets WHERE jid = ? AND asset_type = ? AND is_current = 1',
  ).get(jid, 'product') as { c: number };
  assert.equal(logoCount.c, 1, 'Exactly 1 current logo');
  assert.equal(productCount.c, 1, 'Exactly 1 current product');
  console.log(`✓ Each type has exactly 1 current`);

  // Step 6: Dedup on re-send (if asset 1 bytes arrive again, should reuse)
  console.log('\n=== STEP 6: Dedup on re-send (old logo bytes) ===');
  const resendasset1 = await store.writeAsset({
    jid,
    content: Buffer.from('image-one-bytes'),
    source_message: 'msg-1-resend',
  });
  assert.equal(resendasset1, asset1Id, 'Dedup returns existing asset_id');
  console.log(`✓ Re-send of asset 1 bytes returns existing asset_id (dedup by UNIQUE(jid, bytes_hash))`);

  db.close();
  console.log('\n=== ALL ASSERTIONS PASSED ===\n');
});
