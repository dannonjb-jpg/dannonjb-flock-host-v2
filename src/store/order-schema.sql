-- order-schema.sql
-- Flock shared order state — the SYSTEM OF RECORD.
-- SQLite, WAL mode. After creating the DB:  PRAGMA journal_mode=WAL;
--
-- CONCURRENCY: WAL gives many concurrent readers + ONE writer at a time across the
-- whole DB, so no two writes ever truly collide. The real risk is a lost update from
-- two components doing read-modify-write on the same row. Prevent it with write ownership:
--   orders, payments -> Flock Node host is the SOLE writer (deterministic money + state).
--   quotes           -> supplier agent inserts/updates its quote rows; Penn sets `selected`.
--   events           -> append-only; any component inserts, NONE update or delete.
-- Any cross-component change to an order goes THROUGH the host, not by another writer
-- reaching into `orders` directly.
--
-- Suppliers are NOT stored here. supplier_roster.json stays the single source of truth;
-- this DB references suppliers by their roster id only. Mockup images live on disk/Drive,
-- referenced by URL inside job_spec or events — never stored as blobs here.

PRAGMA foreign_keys = ON;

-- ──────────────────────────────────────────────────────────────────────────
-- orders: one row per job. Pipeline position lives in `state`. Going-dark and
-- escalation are OVERLAYS — they do not overwrite `state`, so the forfeit rules
-- can still read WHERE the client was when they went quiet.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  order_id            TEXT PRIMARY KEY,        -- host-generated ULID/uuid
  created_at          TEXT NOT NULL,           -- ISO8601
  updated_at          TEXT NOT NULL,

  whatsapp_jid        TEXT NOT NULL,           -- inbound-routing index target
  client_name         TEXT,
  business_name       TEXT,
  project_type        TEXT,                    -- 'personal' | 'business'

  job_spec            TEXT,                    -- JSON: specs gathered in intake (+ mockup URLs)
  track               TEXT NOT NULL DEFAULT 'undecided',
  selected_mockup     TEXT,                    -- 'A' | 'B' | NULL

  state               TEXT NOT NULL DEFAULT 'intake',

  dormant_since       TEXT,                    -- ISO8601 when dormancy began (NULL = active)
  follow_up_stage     INTEGER NOT NULL DEFAULT 0,   -- 0 none, 1 (36-48h), 2 (7-day), 3 (monthly)

  escalation          TEXT,                    -- NULL | 'friction'|'mockup_pairs'|'supplier'|'manual'
  dispute_flag        INTEGER NOT NULL DEFAULT 0,

  failed_mockup_pairs INTEGER NOT NULL DEFAULT 0,   -- >=3 triggers human-designer handoff
  digital_rounds_used INTEGER NOT NULL DEFAULT 0,   -- rounds used in the current $5 block

  assigned_supplier_id TEXT,                   -- references supplier_roster.json id

  hermes_session_id   TEXT,                    -- maps conversation -> Hermes session
  turn_count          INTEGER NOT NULL DEFAULT 0,
  last_tier           TEXT,                    -- 'cheap'|'smart' (router stickiness)
  force_tier          TEXT,                    -- NULL|'cheap'|'smart'

  notes               TEXT,

  CHECK (track IN ('undecided','physical','digital')),
  CHECK (state IN (
    'intake', 'mockup', 'awaiting_decision',
    'deposit_pending', 'digital_pending',
    'revision', 'balance_pending', 'in_production',
    'received', 'delivered', 'closed',
    'cancelled', 'forfeited'
  )),
  CHECK (last_tier  IS NULL OR last_tier  IN ('cheap','smart')),
  CHECK (force_tier IS NULL OR force_tier IN ('cheap','smart'))
);

CREATE INDEX IF NOT EXISTS idx_orders_jid   ON orders(whatsapp_jid);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);

-- ──────────────────────────────────────────────────────────────────────────
-- payments: the money ledger. idempotency_key is the double-charge guard.
-- The host derives it DETERMINISTICALLY from the intent (e.g.
-- "{order_id}:{kind}") — never random — so a crash-and-retry re-insert hits the
-- UNIQUE constraint and the same charge cannot fire twice.
-- Margin (per order) = SUM(direction='in', succeeded) - SUM(direction='out', succeeded),
-- once normalized for currency (see fx note below).
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  payment_id      TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(order_id),
  created_at      TEXT NOT NULL,

  kind            TEXT NOT NULL,   -- 'deposit'|'balance'|'digital'|'supplier_deposit'|'revision'|'refund'
  direction       TEXT NOT NULL,   -- 'in' | 'out'
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  fx_to_usd       REAL,            -- rate captured AT PAYMENT TIME (for cross-currency margin)
  method          TEXT,            -- 'stripe'|'zelle'|'oxxo'|'cash'
  status          TEXT NOT NULL DEFAULT 'pending',

  external_ref    TEXT,            -- Stripe PaymentIntent id / Zelle confirmation / etc.
  idempotency_key TEXT NOT NULL UNIQUE,        -- <-- crash-safe guard

  CHECK (kind IN ('deposit','balance','digital','supplier_deposit','revision','refund')),
  CHECK (direction IN ('in','out')),
  CHECK (status IN ('pending','succeeded','failed','refunded'))
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- ──────────────────────────────────────────────────────────────────────────
-- quotes: parallel supplier-quote track, runs from mockup generation onward.
-- supplier agent inserts/updates rows; Penn sets status='selected' on Dan's pick;
-- host reads the selected quote and writes orders.assigned_supplier_id.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotes (
  quote_id        TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(order_id),
  supplier_id     TEXT NOT NULL,   -- references supplier_roster.json id
  requested_at    TEXT NOT NULL,
  received_at     TEXT,

  amount_cents    INTEGER,
  currency        TEXT DEFAULT 'MXN',
  turnaround_days INTEGER,
  status          TEXT NOT NULL DEFAULT 'requested',
  raw             TEXT,            -- freeform supplier reply, kept for audit

  CHECK (status IN ('requested','received','selected','rejected','expired'))
);

CREATE INDEX IF NOT EXISTS idx_quotes_order ON quotes(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_order_supplier ON quotes(order_id, supplier_id);

-- ──────────────────────────────────────────────────────────────────────────
-- events: append-only audit + restart-safety + raw material for the data-eval module.
-- On restart the host answers "what have I already done for this order?" by reading
-- events, NOT by guessing from logs. Never updated, never deleted.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  order_id    TEXT REFERENCES orders(order_id),  -- nullable: some system events are order-less
  created_at  TEXT NOT NULL,
  actor       TEXT NOT NULL,   -- 'flock'|'supplier'|'penn'|'client'|'system'
  type        TEXT NOT NULL,   -- 'state_change'|'msg_sent'|'msg_recv'|'quote_recv'|'payment'|'escalation'
  payload     TEXT,            -- JSON
  -- Restart-safety: a reply event links back to the inbound it answered (§9).
  inbound_event_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);
CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_inbound ON events(inbound_event_id);
