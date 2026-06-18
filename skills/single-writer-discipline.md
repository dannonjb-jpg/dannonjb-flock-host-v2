---
name: single-writer-discipline
description: "Guides agents through the sole-writer rule for orders, payments, and assets. Use when adding a new component, migration script, Penn integration, or any code that touches those tables."
---

## Overview

The Flock Node host process is the only component that writes to `orders`, `payments`, and `assets`/`asset_bytes`. Penn is read-only on orders. Suppliers write only to `quotes`. `events` is append-only; any component may insert, none may update or delete. Cross-component changes to an order go through the host, not by another writer reaching into tables directly.

Source: src/store/order-schema.sql header §"CONCURRENCY"; src/store/sqlite-store.ts line 3; flock-asset-store.md §"Sole writer"; CLAUDE.md §"Penn + orchestrator architecture".

## When to Use

- Adding a new process or script that needs order/payment data
- Writing a schema migration or backfill
- Reviewing whether Penn or a cron job should write directly vs. via a host API

## Process

1. Before writing to `orders`/`payments`/`assets`: confirm the writer is the Flock Node host process. `SqliteStore` is constructed once in `src/index.ts` and injected — that construction point is the enforcement boundary. src/store/sqlite-store.ts line 3: "The host process is the only thing that constructs this, which is what physically enforces single-writer discipline on orders & payments (§1)."
2. For `events`: any actor (`flock`/`supplier`/`penn`/`client`/`system`) may INSERT. None may UPDATE or DELETE. order-schema.sql header §"events — append-only".
3. For `quotes`: supplier agent inserts/updates its own rows; Penn sets `status='selected'`. Host then reads the selected quote to write `orders.assigned_supplier_id`. order-schema.sql §"quotes".
4. For `assets`/`asset_bytes`: same sole-writer rule as orders/payments. flock-asset-store.md §"Sole writer: the Flock Node host only, same single-writer discipline as orders/payments."
5. For migrations: wrap in `BEGIN`/`COMMIT`, verify row counts before cleanup. migrations/payments-add-revision-kind.sql is the reference pattern. Never run ad-hoc `UPDATE`s against live tables outside a reviewed migration file.
6. Penn reads `orders` read-only only. CLAUDE.md §"Penn reads the DB read-only; all task mutations go through the CLI inside one transaction."
7. Money-path file changes (`src/brain/action-applier.ts`, `src/payments/**`, `src/store/**`, `src/ops/scheduler.ts`) require `./scripts/deploy.sh --reviewed`, not a bare restart. CLAUDE.md §"Deploy guard".

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "It's a one-off backfill — easier to write directly." | Direct writes bypass event logging, idempotency keys, and state-machine validation. The invariant breaks silently. Source: order-schema.sql header. |
| "Penn needs to update order notes for operator context." | Penn is read-only on orders. Expose a host API endpoint if write access is genuinely required. Source: CLAUDE.md §"Penn + orchestrator architecture". |
| "The UNIQUE idempotency_key protects against duplicates anyway." | That key protects the `payments` table only. A rogue second writer to `orders` or `assets` has no such guard. Source: order-schema.sql §"payments — idempotency_key is the double-charge guard". |

## Red Flags

- Any process other than the host Node service holding a write transaction on `orders`, `payments`, or `assets`
- `SqliteStore` constructed in a second process (cron, migration runner, Penn binary)
- Direct `UPDATE orders SET …` in a migration without `BEGIN`/`COMMIT` and row-count verification
- `events` rows being updated or deleted

## Verification

- `lsof /root/flock-host-v2/flock.db | grep -v ' r '` — only the host PID should have write access
- `SELECT COUNT(*) FROM events WHERE actor NOT IN ('flock','supplier','penn','client','system')` = 0
- Migration: `SELECT COUNT(*) FROM payments_new` = `SELECT COUNT(*) FROM payments_old` before the old table is dropped (see migrations/payments-add-revision-kind.sql §verify step)
- `npm test` — test/core.test.ts covers store-level invariants
