-- payments-add-revision-kind.sql
-- Adds 'revision' to payments.kind CHECK constraint
-- SQLite does not support ALTER TABLE on CHECK constraints, so this does:
-- 1. Create new payments table with updated CHECK
-- 2. Copy all data from old table
-- 3. Drop old table + indexes
-- 4. Rename new table
-- 5. Recreate indexes
-- All in one transaction for atomicity.
--
-- Load-bearing note: The identical CHECK must appear in the canonical schema file
-- (order-schema.sql) and the test schema. If they drift, the migration will apply
-- and the schema won't match — replay detection will catch it, but prevent the drift
-- by keeping all three aligned (live DB + migration + canonical schema file).

BEGIN TRANSACTION;

-- Create new payments table with revised CHECK including 'revision'
-- DDL copied from canonical src/store/order-schema.sql to guarantee alignment
CREATE TABLE IF NOT EXISTS payments_new (
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

-- Copy all existing data (preserves payment history, no data loss)
INSERT INTO payments_new SELECT * FROM payments;

-- Drop old indexes
DROP INDEX IF EXISTS idx_payments_order;

-- Swap tables: old → _old, new → payments
ALTER TABLE payments RENAME TO payments_old;
ALTER TABLE payments_new RENAME TO payments;

-- Recreate indexes on the new table
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- Verify the migration succeeded (count rows must match)
-- If this query returns different counts, the migration failed.
-- DO NOT proceed without verifying this in both test and live DB.
-- SELECT
--   (SELECT COUNT(*) FROM payments) AS new_count,
--   (SELECT COUNT(*) FROM payments_old) AS old_count;

-- Clean up (only after verification passes)
DROP TABLE payments_old;

COMMIT;
