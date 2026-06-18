---
name: cas-exactly-once
description: "Guides agents through the compare-and-swap payment confirmation pattern. Use when handling Stripe webhook redelivery, concurrent events, or manual confirm endpoints."
---

## Overview

Payment confirmation uses a conditional `UPDATE WHERE status='pending'` so that only the first delivery of a webhook can flip a row to `succeeded`. SQLite returns a `changes` count; `changes===0` means another delivery already won and the caller must no-op rather than advance state again. The confirm + state transition must run inside a single synchronous `db.transaction()` — splitting them reopens the crash window.

Source: src/payments/payment-ops.ts:confirmInTransaction(); src/store/sqlite-store.ts:markPaymentStatusIfPending(); test/idempotency-concurrent-webhook.test.ts.

## When to Use

- Implementing or reviewing webhook handlers
- Adding a manual confirm endpoint
- Debugging double state-transitions after a network flap or Stripe retry

## Process

1. Wrap confirm + state transition in a single `db.transaction()`. `confirmInTransaction()` throws immediately if `!db.inTransaction`. src/payments/payment-ops.ts:confirmInTransaction() line ~231.
2. Inside the transaction, call `ops.confirmInTransaction(paymentId, externalRef)`. src/payments/payment-ops.ts:confirmInTransaction().
3. Method executes `UPDATE payments SET status='succeeded' WHERE payment_id=? AND status='pending'`. src/store/sqlite-store.ts:markPaymentStatusIfPending() line ~175.
4. Check `res.changes`: if `0`, a concurrent delivery already succeeded — return `{ won: false }` and skip state advance entirely. src/payments/payment-ops.ts line ~243.
5. If `won===true`: append payment event, then advance order state — both inside the same transaction. src/ops/stripe-webhook.ts:handleStripeEvent() implements this pattern.
6. Always return `2xx` to Stripe regardless of won/lost — Stripe must stop retrying. src/ops/stripe-webhook.ts line ~87–92.

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "Stripe guarantees at-most-once delivery." | Stripe guarantees at-least-once. Network retries and failover produce duplicates. Source: stripe-webhook.ts §"Handler invariants — All handlers are idempotent". |
| "Checking `changes` is over-engineering for a single process." | The same guard handles crash-replay, not just concurrency. A process that crashes after marking but before transitioning replays the webhook — same race. Source: payment-ops.ts:confirmInTransaction(). |
| "The transaction can wrap just the DB writes; the state advance can follow." | A crash between mark-succeeded and state-transition leaves a `succeeded` payment with the order still at `deposit_pending`. Source: payment-ops.ts comment "MUST be called inside an outer db.transaction() wrapper — atomicity required". |

## Red Flags

- `store.markPaymentStatus()` (unconditional) used instead of `store.markPaymentStatusIfPending()` in any webhook or replay path
- `confirmInTransaction()` called outside a `db.transaction()` wrapper — it throws at runtime, but only then
- State transition (`store.transition()`) executed after the transaction has already closed
- `won` return value ignored; state always advanced regardless

## Verification

- `npm test` — test/idempotency-concurrent-webhook.test.ts asserts: `firstWon===true`, `secondWon===false`, exactly one payment event, exactly one state_change to `'revision'`
- `SELECT COUNT(*) FROM events WHERE order_id=? AND type='payment' AND payload LIKE '%succeeded%'` = 1 even after two simulated concurrent deliveries
- `SELECT status, external_ref FROM payments WHERE payment_id=?` = `'succeeded'` with the correct Stripe session ID set once
