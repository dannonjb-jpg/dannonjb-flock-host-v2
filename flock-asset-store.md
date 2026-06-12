# Flock Asset Store — Schema Spec

Persistent, content-addressed customer asset store. Replaces the ephemeral asset
handling. Feeds intake validation and the Sharp compositing pipeline.

**Two identities, kept separate — this is the spine of the design:**

- `asset_bytes` = **content identity**. The bytes, deduped by SHA256. Write-once.
- `assets` = **binding identity**. *This jid's logo, this role, this version, at this
 time.* A UUID, not a hash — so the same bytes can legitimately appear under multiple
 jids, types, or versions without colliding.

**Sole writer:** the Flock Node host only, same single-writer discipline as
`orders`/`payments`. SQLite, WAL mode.

-----

## DDL

```sql
-- flock-asset-store.sql
PRAGMA foreign_keys = ON;

-- ── CONTENT LAYER ────────────────────────────────────────────────────────────
-- Content-addressed, write-once. Identical bytes from anyone collapse to one row.
-- This is where byte-identical concurrent uploads dedup naturally (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS asset_bytes (
 bytes_hash TEXT PRIMARY KEY, -- SHA256(content), lowercase hex
 content BLOB NOT NULL,
 bytes_size INTEGER NOT NULL,
 created_at TEXT NOT NULL -- ISO8601; first time these bytes were seen
);

-- ── BINDING LAYER ─────────────────────────────────────────────────────────────
-- One row per (jid, logical asset, version). asset_id is a UUID, NOT the content hash,
-- so the same bytes under different jids/types/versions never collide on the PK.
CREATE TABLE IF NOT EXISTS assets (
 asset_id TEXT PRIMARY KEY, -- randomUUID() — BINDING identity
 jid TEXT NOT NULL, -- customer identifier
 bytes_hash TEXT NOT NULL
 REFERENCES asset_bytes(bytes_hash), -- CONTENT identity (FK)

 asset_type TEXT NOT NULL DEFAULT 'unknown',
 role TEXT NOT NULL DEFAULT 'unknown', -- INTENT ONLY
 role_source TEXT NOT NULL DEFAULT 'proposed_unconfirmed',

 -- Usability INPUTS (measured at intake). The print-fidelity verdict is DERIVED from
 -- these at read time — never stored as a settled boolean. resolution_hint is the
 -- coarse class; the dims / is_vector are the truth the verdict is computed from.
 resolution_hint TEXT NOT NULL DEFAULT 'unknown',
 width_px INTEGER, -- NULL for vector
 height_px INTEGER, -- NULL for vector
 is_vector INTEGER NOT NULL DEFAULT 0, -- 1 = resolution-independent (PDF/SVG)

 version INTEGER NOT NULL, -- per (jid, asset_type), strictly increasing
 is_current INTEGER NOT NULL DEFAULT 0,-- exactly one current per (jid, asset_type)

 source_message TEXT, -- inbound_event_id that carried these bytes
 -- (image<->caption binding lives in intake)
 created_at TEXT NOT NULL, -- ISO8601; when this binding row was written
 notes TEXT, -- free-text quality flags

 CHECK (asset_type IN ('logo','product','reference','unknown')),
 CHECK (role IN ('fidelity','reference','unknown')),
 CHECK (role_source IN ('client_stated','proposed_unconfirmed')),
 CHECK (resolution_hint IN ('whatsapp','vector','high_res','unknown')),
 CHECK (is_vector IN (0,1)),
 CHECK (is_current IN (0,1))
);

-- Same bytes for the same customer = one binding row. Re-receipt of identical bytes
-- (Baileys at-least-once, or "did you get it?" resends) dedups here instead of minting
-- a spurious new version. New content = new bytes_hash = new row = version bump.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_jid_bytes
 ON assets(jid, bytes_hash);

-- CONCURRENCY GUARDRAIL #1 — at most one current per (jid, asset_type), enforced by
-- the DB. This backstop does NOT depend on the FIFO lock's (still-unvalidated)
-- concurrent-arrival guarantee: a second writer racing to mark current violates this
-- and must retry, instead of producing two current logos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_current
 ON assets(jid, asset_type) WHERE is_current = 1;

-- CONCURRENCY GUARDRAIL #2 — version numbers unique per (jid, asset_type). Turns the
-- MAX(version)+1 read-modify-write race into a constraint violation + retry, not a
-- silent duplicate version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_version
 ON assets(jid, asset_type, version);

CREATE INDEX IF NOT EXISTS idx_assets_jid ON assets(jid);
CREATE INDEX IF NOT EXISTS idx_assets_lookup ON assets(jid, asset_type, role);
```

-----

## Operational Contracts

These are the constraints the write/read paths must honor — the DDL's intent
is unambiguous with them spelled out.

### Version-swap ordering (clear-then-set, one transaction)

SQLite checks the `idx_assets_current` partial unique index per statement, not deferred.
Promoting a new version must, inside a single transaction, **clear the old current first,
then set the new**:

```sql
BEGIN;
 UPDATE assets SET is_current = 0 WHERE jid=? AND asset_type=? AND is_current = 1;
 UPDATE assets SET is_current = 1 WHERE asset_id = ?;
COMMIT;
```

Setting the new before clearing the old would trip the index mid-transaction.

### Revert is a flip, not an insert

`UNIQUE(jid, bytes_hash)` prevents a new row when identical bytes are re-sent after a
rebrand (client reverting to an old logo). The write path detects the existing row and
re-activates it via the same clear-then-set swap above. No duplicate identical version
is ever minted.

### Usability is derived at read time, never stored

`role` is intent only. A `role='fidelity', role_source='client_stated'` asset that is
`resolution_hint='whatsapp'` is a real, representable state: the client said "this is my
logo," but it cannot be placed at print scale.

The read path computes the verdict and the compositor / intake acts on it:

```
fidelity_usable(asset, target_placement) :=
 role == 'fidelity'
 AND role_source == 'client_stated'
 AND ( is_vector == 1
       OR min(width_px, height_px) >= print_min_px(target_placement) )
```

`print_min_px` is **placement-dependent** (from Gate 2: ~1600px WhatsApp blurs at the
1800px quarter, severe at 7200px full width) — so the real check lives in the compositor
where the target render size is known.

The store's job is to surface the inputs and the intent, not to bake a magic threshold
into SQL. `resolve_logo` returns `(bytes, resolution_hint, width_px, height_px, is_vector,
role, role_source)` so the caller can decide: composite, or go back to the client for a
vector. **Silently returning a whatsapp-res logo here is exactly the pixelated-banner
failure the spike eliminated — do not do this.**

### Full history, no pruning

Old orders time-bind to old versions by `asset_id`. Pruning a version breaks the
provenance of what was actually printed.

Binding rows are tiny; bytes are deduped. If storage ever bites, GC unreferenced
`asset_bytes` BLOBs via the FK — never the `assets` metadata rows, and not now.
