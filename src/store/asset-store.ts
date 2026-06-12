// store/asset-store.ts
// Asset persistence layer: content-addressed bytes + per-jid bindings.
// Single writer (host), content-deduped, version-tracked, role-confirmable.
// Works synchronously with better-sqlite3.

import crypto from 'node:crypto';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { Clock, IdGen } from '../domain/ports.js';

// ── Types ─────────────────────────────────────────────────────────────────

export type AssetType = 'logo' | 'product' | 'reference' | 'unknown';
export type Role = 'fidelity' | 'reference' | 'unknown';
export type RoleSource = 'client_stated' | 'proposed_unconfirmed';
export type ResolutionHint = 'whatsapp' | 'vector' | 'high_res' | 'unknown';

export interface AssetMeta {
  asset_id: string;
  jid: string;
  bytes_hash: string;
  asset_type: AssetType;
  role: Role;
  role_source: RoleSource;
  resolution_hint: ResolutionHint;
  width_px: number | null;
  height_px: number | null;
  is_vector: boolean;
  version: number;
  is_current: boolean;
  source_message: string | null; // inbound_event_id for caption binding
  created_at: string;
}

export interface ResolvedAsset extends AssetMeta {
  content: Buffer;
  bytes_size: number;
}

export type Verdict =
  | { usable: true }
  | { usable: false; reason: 'no_asset' | 'unconfirmed' | 'wrong_role' | 'too_low_res'; detail?: string };

export interface AssetInput {
  jid: string;
  content: Buffer;
  source_message?: string; // inbound_event_id for caption binding
  mime?: string; // MIME type for vector detection (application/pdf, image/svg+xml)
}

export const PRINT_FLOOR_PX = 1500;

/**
 * Coarse, placement-agnostic usability floor. The compositor's fidelityVerdict
 * does the precise, placement-aware check; this is the host's net for the obvious
 * whatsapp-res case.
 */
export function coarseUsable(m: AssetMeta): boolean {
  if (m.is_vector) return true;
  return Math.min(m.width_px ?? 0, m.height_px ?? 0) >= PRINT_FLOOR_PX;
}

export interface InspectionResult {
  width_px: number | null;
  height_px: number | null;
  is_vector: number;
  resolution_hint: 'whatsapp' | 'vector' | 'high_res' | 'unknown';
}

export class AssetStore {
  constructor(
    private db: Database.Database,
    private clock: Clock,
    private idGen: IdGen,
  ) {}

  /**
   * Hash asset bytes with SHA256.
   */
  private hashBytes(content: Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
  }

  /**
   * Inspect asset dimensions and format (vector vs raster, resolution hint).
   * Called on intake to populate the usability inputs.
   * 
   * Vector detection strategy (robust to XML declarations, comments, leading bytes):
   * 1. Scan first ~1KB for magic bytes: %PDF- (PDF files may have leading bytes)
   * 2. Scan first ~1KB for SVG markers: <?xml, <svg (may have comments/whitespace before them)
   *    Strip UTF-8 BOM before scanning
   * 3. Check MIME hint (application/pdf, image/svg+xml) as secondary signal
   * 4. Fall back to sharp's format detection for rasters
   * 
   * Resolution hint for rasters: min(w, h) vs PRINT_FLOOR_PX.
   */
  async inspectAsset(content: Buffer, mime?: string): Promise<InspectionResult> {
    try {
      // Scan first ~1KB for vector format markers
      const scanLen = Math.min(1024, content.length);
      const scanBuf = content.slice(0, scanLen);
      
      // PDF: search for %PDF- magic bytes (some PDFs have leading bytes before the signature)
      const scanStr = scanBuf.toString('ascii', 0, Math.min(512, scanLen));
      const isPDF = scanStr.includes('%PDF');

      // SVG: strip UTF-8 BOM, then scan for <?xml or <svg (may appear after comments/whitespace)
      let svgText = scanBuf.toString('utf8');
      // Strip UTF-8 BOM if present (0xEF 0xBB 0xBF)
      if (scanBuf[0] === 0xef && scanBuf[1] === 0xbb && scanBuf[2] === 0xbf) {
        svgText = svgText.slice(1); // slice removes the BOM character
      }
      // Look for XML or SVG markers (case-insensitive, allowing whitespace/comments before them)
      const isSVG = /^\s*(?:<\?xml|<!--[\s\S]*?-->\s*)*<svg/i.test(svgText);

      if (isPDF || isSVG) {
        return {
          width_px: null,
          height_px: null,
          is_vector: 1,
          resolution_hint: 'vector',
        };
      }

      // MIME-based vector check (secondary signal for edge cases)
      if (mime === 'application/pdf' || mime === 'image/svg+xml') {
        return {
          width_px: null,
          height_px: null,
          is_vector: 1,
          resolution_hint: 'vector',
        };
      }

      // Raster: use sharp to measure dimensions
      const metadata = await sharp(content).metadata();
      const minDim = Math.min(metadata.width ?? 0, metadata.height ?? 0);
      const resolution_hint: ResolutionHint = minDim >= PRINT_FLOOR_PX ? 'high_res' : minDim > 0 ? 'whatsapp' : 'unknown';

      return {
        width_px: metadata.width ?? null,
        height_px: metadata.height ?? null,
        is_vector: 0,
        resolution_hint,
      };
    } catch (err) {
      // If inspection fails, default to unknown (no asset row written)
      console.error(`[asset-store] inspectAsset failed: ${err}`);
      return {
        width_px: null,
        height_px: null,
        is_vector: 0,
        resolution_hint: 'unknown',
      };
    }
  }

  /**
   * Write asset: hash → dedup check → persist bytes → bind with metadata.
   * 
   * Returns asset_id on success. If identical bytes exist for this jid,
   * returns the existing asset_id (dedup by UNIQUE(jid, bytes_hash)).
   * 
   * All written assets start with:
   * - asset_type='unknown' (not set at write; fixed at confirm)
   * - role='unknown', role_source='proposed_unconfirmed'
   * - version=0 (sentinel; real version allocated at confirm/promotion)
   * - is_current=0
   */
  async writeAsset(input: AssetInput): Promise<string> {
    const bytes_hash = this.hashBytes(input.content);
    const inspection = await this.inspectAsset(input.content, input.mime);
    const asset_id = this.idGen.next();
    const now = this.clock.nowIso();

    try {
      // Transaction: insert bytes (or ignore if duplicate), then bind metadata
      const txn = this.db.transaction(() => {
        // Insert content (content-addressed, write-once by bytes_hash)
        // INSERT OR IGNORE handles the case where identical bytes were seen before
        this.db.prepare(`
          INSERT OR IGNORE INTO asset_bytes (bytes_hash, content, bytes_size, created_at)
          VALUES (?, ?, ?, ?)
        `).run(bytes_hash, input.content, input.content.length, now);

        // Check if (jid, bytes_hash) already exists (dedup at binding layer)
        const existing = this.db.prepare(`
          SELECT asset_id, asset_type, role, role_source, is_current FROM assets
          WHERE jid = ? AND bytes_hash = ?
          LIMIT 1
        `).get(input.jid, bytes_hash) as { asset_id: string; asset_type: string; role: string; role_source: string; is_current: number } | undefined;

        if (existing) {
          // If already confirmed and not current, client is re-sending to restore it — re-promote.
          if (existing.role_source === 'client_stated' && existing.is_current === 0 && existing.role === 'fidelity') {
            const maxVerRow = this.db.prepare(`
              SELECT COALESCE(MAX(version), 0) + 1 as next_v FROM assets
              WHERE jid = ? AND asset_type = ? AND role = 'fidelity'
            `).get(input.jid, existing.asset_type) as { next_v: number } | undefined;
            const nextVersion = maxVerRow?.next_v ?? 1;
            this.db.prepare(`UPDATE assets SET is_current = 0 WHERE jid = ? AND asset_type = ? AND is_current = 1`).run(input.jid, existing.asset_type);
            this.db.prepare(`UPDATE assets SET is_current = 1, version = ? WHERE asset_id = ?`).run(nextVersion, existing.asset_id);
            console.log(`[asset-store] dedup-repromote: jid=${input.jid}, bytes=${bytes_hash.slice(0, 8)}... → asset_id=${existing.asset_id}, version=${nextVersion}`);
          } else {
            console.log(`[asset-store] dedup: jid=${input.jid}, bytes=${bytes_hash.slice(0, 8)}... → asset_id=${existing.asset_id}`);
          }
          return existing.asset_id;
        }

        // New binding: write as pending with sentinel version=0
        // asset_type is unknown; it gets fixed at confirm. This allows multiple pending
        // images to exist at (jid, unknown, 0) without colliding on the partial version index.
        this.db.prepare(`
          INSERT INTO assets (
            asset_id, jid, bytes_hash, asset_type, role, role_source,
            resolution_hint, width_px, height_px, is_vector,
            version, is_current, source_message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          asset_id,
          input.jid,
          bytes_hash,
          'unknown', // asset_type is fixed at confirm, not at write
          'unknown', // role unconfirmed until client states intent
          'proposed_unconfirmed',
          inspection.resolution_hint,
          inspection.width_px,
          inspection.height_px,
          inspection.is_vector ? 1 : 0,
          0, // version=0 (sentinel); real version allocated at confirm
          0, // is_current = 0 until promoted at confirm
          input.source_message ?? null,
          now,
        );

        return asset_id;
      });

      const result = txn();
      console.log(`[asset-store] wrote asset: asset_id=${result}, jid=${input.jid}, vector=${inspection.is_vector}, resolution=${inspection.resolution_hint}`);
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[asset-store] writeAsset failed: ${detail}`);
      throw err;
    }
  }

  /**
   * Confirm the role of an asset after the client identifies it.
   * 
   * For fidelity (logo, product): allocates version in the (jid, assetType, fidelity) namespace,
   * clears old current, promotes to current in one transaction.
   * 
   * For reference/discarded: sets type + role, no version allocation, no promotion.
   */
  confirmAssetRole(
    asset_id: string,
    assetType: AssetType,
    role: Role,
    promote: boolean = false,
  ): void {
    try {
      const txn = this.db.transaction(() => {
        // Get the asset to find jid
        const asset = this.db.prepare(`
          SELECT jid FROM assets WHERE asset_id = ?
        `).get(asset_id) as { jid: string } | undefined;

        if (!asset) {
          throw new Error(`asset not found: ${asset_id}`);
        }

        if (promote && role === 'fidelity') {
          // Allocate version for this (jid, assetType) in fidelity namespace
          const maxVerRow = this.db.prepare(`
            SELECT COALESCE(MAX(version), 0) + 1 as next_v FROM assets
            WHERE jid = ? AND asset_type = ? AND role = 'fidelity'
          `).get(asset.jid, assetType) as { next_v: number } | undefined;
          const nextVersion = maxVerRow?.next_v ?? 1;

          // Clear old current for this type (statement 1 — must fire before statement 2)
          this.db.prepare(`
            UPDATE assets SET is_current = 0
            WHERE jid = ? AND asset_type = ? AND is_current = 1
          `).run(asset.jid, assetType);

          // Set new current with type + version allocated (statement 2)
          this.db.prepare(`
            UPDATE assets
            SET asset_type = ?, role = 'fidelity', role_source = 'client_stated',
                version = ?, is_current = 1
            WHERE asset_id = ?
          `).run(assetType, nextVersion, asset_id);

          console.log(`[asset-store] confirmed: asset_id=${asset_id}, type=${assetType}, version=${nextVersion}, promoted=true`);
        } else {
          // reference/discarded: set type + role, no version, no promotion
          this.db.prepare(`
            UPDATE assets
            SET asset_type = ?, role = ?, role_source = 'client_stated'
            WHERE asset_id = ?
          `).run(assetType, role, asset_id);

          console.log(`[asset-store] confirmed: asset_id=${asset_id}, type=${assetType}, role=${role}, promoted=false`);
        }
      });

      txn();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[asset-store] confirmAssetRole failed: ${detail}`);
      throw err;
    }
  }



  /**
   * Resolve asset metadata only (no blob join). Use for intake checks where you only
   * need dimensions for the fidelity verdict, without loading the full content.
   */
  resolveAssetMeta(jid: string, assetType: AssetType, version: 'current' | number = 'current'): AssetMeta | null {
    try {
      const META_COLS = `a.asset_id, a.jid, a.bytes_hash, a.asset_type, a.role, a.role_source,
        a.resolution_hint, a.width_px, a.height_px, a.is_vector, a.version, a.is_current, a.created_at`;

      const row = version === 'current'
        ? this.db.prepare(`
            SELECT ${META_COLS} FROM assets a
            WHERE a.jid = ? AND a.asset_type = ? AND a.is_current = 1
          `).get(jid, assetType)
        : this.db.prepare(`
            SELECT ${META_COLS} FROM assets a
            WHERE a.jid = ? AND a.asset_type = ? AND a.version = ?
          `).get(jid, assetType, version);

      if (!row) return null;
      return hydrateMeta(row);
    } catch (err) {
      console.error(`[asset-store] resolveAssetMeta failed: ${err}`);
      return null;
    }
  }

  /**
   * Resolve asset with full content (blob join). Use once committed to compositing.
   */
  resolveAsset(jid: string, assetType: AssetType, version: 'current' | number = 'current'): ResolvedAsset | null {
    try {
      const META_COLS = `a.asset_id, a.jid, a.bytes_hash, a.asset_type, a.role, a.role_source,
        a.resolution_hint, a.width_px, a.height_px, a.is_vector, a.version, a.is_current, a.created_at`;

      const row = version === 'current'
        ? this.db.prepare(`
            SELECT ${META_COLS}, b.content AS content, b.bytes_size AS bytes_size
            FROM assets a JOIN asset_bytes b ON b.bytes_hash = a.bytes_hash
            WHERE a.jid = ? AND a.asset_type = ? AND a.is_current = 1
          `).get(jid, assetType)
        : this.db.prepare(`
            SELECT ${META_COLS}, b.content AS content, b.bytes_size AS bytes_size
            FROM assets a JOIN asset_bytes b ON b.bytes_hash = a.bytes_hash
            WHERE a.jid = ? AND a.asset_type = ? AND a.version = ?
          `).get(jid, assetType, version);

      if (!row) return null;
      return hydrate(row);
    } catch (err) {
      console.error(`[asset-store] resolveAsset failed: ${err}`);
      return null;
    }
  }

  /**
   * Convenience for logo resolution.
   */
  resolveLogo(jid: string, version: 'current' | number = 'current'): ResolvedAsset | null {
    return this.resolveAsset(jid, 'logo', version);
  }

  /**
   * Intake's pending assets: those waiting on role confirmation.
   * Ordered by created_at ASC (oldest first) as tiebreak, then asset_id ASC for stability.
   * The first result is the "focus" asset that the brain should ask about.
   */
  pendingAssets(jid: string): AssetMeta[] {
    try {
      const META_COLS = `a.asset_id, a.jid, a.bytes_hash, a.asset_type, a.role, a.role_source,
        a.resolution_hint, a.width_px, a.height_px, a.is_vector, a.version, a.is_current, a.created_at`;

      const rows = this.db.prepare(`
        SELECT ${META_COLS} FROM assets a
        WHERE a.jid = ? AND a.role_source = 'proposed_unconfirmed'
        ORDER BY a.created_at ASC, a.asset_id ASC
      `).all(jid) as any[];

      return rows.map(hydrateMeta);
    } catch (err) {
      console.error(`[asset-store] pendingAssets failed: ${err}`);
      return [];
    }
  }

  /**
   * Resolve a pending asset by its ref (asset_id prefix).
   * Used by confirm_asset action to map the brain's ref back to a specific asset.
   * Returns null if no unique match (ambiguous, missing, or already confirmed).
   */
  resolvePendingByRef(jid: string, ref: string): AssetMeta | null {
    try {
      const META_COLS = `a.asset_id, a.jid, a.bytes_hash, a.asset_type, a.role, a.role_source,
        a.resolution_hint, a.width_px, a.height_px, a.is_vector, a.version, a.is_current, a.created_at`;

      const rows = this.db.prepare(`
        SELECT ${META_COLS} FROM assets a
        WHERE a.jid = ? AND a.role_source = 'proposed_unconfirmed'
        AND a.asset_id LIKE ? || '%'
      `).all(jid, ref) as any[];

      if (rows.length !== 1) {
        // None or ambiguous
        console.warn(`[asset-store] resolvePendingByRef: jid=${jid}, ref=${ref} → ${rows.length} matches (expected 1)`);
        return null;
      }
      return hydrateMeta(rows[0]);
    } catch (err) {
      console.error(`[asset-store] resolvePendingByRef failed: ${err}`);
      return null;
    }
  }
}

// ── Hydration helpers ──────────────────────────────────────────────────────

function hydrateMeta(r: any): AssetMeta {
  return {
    asset_id: r.asset_id,
    jid: r.jid,
    bytes_hash: r.bytes_hash,
    asset_type: r.asset_type,
    role: r.role,
    role_source: r.role_source,
    resolution_hint: r.resolution_hint,
    width_px: r.width_px ?? null,
    height_px: r.height_px ?? null,
    is_vector: !!r.is_vector,
    version: r.version,
    is_current: !!r.is_current,
    source_message: r.source_message ?? null,
    created_at: r.created_at,
  };
}

function hydrate(r: any): ResolvedAsset {
  return {
    ...hydrateMeta(r),
    content: r.content as Buffer,
    bytes_size: r.bytes_size,
  };
}

// ── Fidelity verdict (compositor side, not in store) ──────────────────────

/**
 * Compute fidelity usability for a specific placement.
 * 
 * targetMinPx = shortest edge of the placement box at print DPI.
 * For a left-quarter banner at 4×10 ft @ 150 DPI:
 * - quarter width = 1800 px
 * - target = 1800 px (or less if logo is expected smaller)
 * 
 * This is a pure function; placement math lives with the compositor.
 */
export function fidelityVerdict(asset: AssetMeta | null, targetMinPx: number): Verdict {
  if (!asset) return { usable: false, reason: 'no_asset' };
  if (asset.role !== 'fidelity') return { usable: false, reason: 'wrong_role', detail: asset.role };
  if (asset.role_source !== 'client_stated') return { usable: false, reason: 'unconfirmed' };
  if (asset.is_vector) return { usable: true };
  
  const shortEdge = Math.min(asset.width_px ?? 0, asset.height_px ?? 0);
  if (shortEdge < targetMinPx) {
    return { usable: false, reason: 'too_low_res', detail: `${shortEdge}px < ${targetMinPx}px` };
  }
  return { usable: true };
}
