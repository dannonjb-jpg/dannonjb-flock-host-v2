-- flock-asset-store schema migration
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

 version INTEGER NOT NULL, -- per (jid, asset_type, fidelity), strictly increasing. Sentinel=0 for pending/unknown.
 is_current INTEGER NOT NULL DEFAULT 0,-- exactly one current per (jid, asset_type); always fidelity

 source_message TEXT, -- inbound_event_id that carried these bytes
 -- (image<->caption binding lives in intake)
 created_at TEXT NOT NULL, -- ISO8601; when this binding row was written
 notes TEXT, -- free-text quality flags

 CHECK (asset_type IN ('logo','product','reference','unknown')),
 CHECK (role IN ('fidelity','reference','unknown','discarded')),
 CHECK (role_source IN ('client_stated','proposed_unconfirmed')),
 CHECK (resolution_hint IN ('whatsapp','vector','high_res','unknown')),
 CHECK (is_vector IN (0,1)),
 CHECK (is_current IN (0,1))
);

-- Same bytes for the same customer = one binding row. Re-receipt of identical bytes
-- (Baileys at-least-once, or "did you get it?" resends) dedups here instead of minting
-- a spurious new asset_id. New content = new bytes_hash = new row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_jid_bytes
 ON assets(jid, bytes_hash);

-- CONCURRENCY GUARDRAIL #1 — at most one current per (jid, asset_type), enforced by
-- the DB. This backstop does NOT depend on the FIFO lock's (still-unvalidated)
-- concurrent-arrival guarantee: a second writer racing to mark current violates this
-- and must retry, instead of producing two current logos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_current
 ON assets(jid, asset_type) WHERE is_current = 1;

-- CONCURRENCY GUARDRAIL #2 — version numbers unique per (jid, asset_type, role=fidelity).
-- PARTIAL: only versioned, single-canonical types (logo/product) at confirmed fidelity get
-- uniqueness. Pending/unknown/reference/discarded are exempt, allowing multiple pending
-- images to coexist at version=0 without collision. Turns the MAX(version)+1 race into a
-- constraint violation + retry, not a silent duplicate version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_version
 ON assets(jid, asset_type, version) WHERE role = 'fidelity';

CREATE INDEX IF NOT EXISTS idx_assets_jid ON assets(jid);
CREATE INDEX IF NOT EXISTS idx_assets_lookup ON assets(jid, asset_type, role);
