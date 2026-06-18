---
name: insert-before-charge
description: "Guides agents through the two-phase write discipline: DB row written before provider call (money path); media confirmed present before state advances (mockup path). Use when adding payment flows, charge retries, or mockup delivery logic."
---

## Overview

Two separate "write before" invariants guard against crashes at different points. On the money path, a `payments` row with `status='pending'` is written before any Stripe call, so a crash-and-retry hits the `UNIQUE idempotency_key` constraint and cannot double-charge. On the mockup path, media URLs must be confirmed present before the order advances out of `mockup` state, so a client never reaches `awaiting_decision` with no images.

Source: src/payments/payment-ops.ts §"INSERT-BEFORE-CHARGE"; SAFETY_GATES.md §"Gate 1: Present-Before-Advance".

## When to Use

- Adding a new payment kind or charge path
- Adding a media delivery step that precedes a state transition
- Debugging a double-charge or a state advance without visible media

## Process

**Money path:**

1. Compute idempotency key deterministically: `{order_id}:{kind}:{discriminator}` — never random. src/payments/payment-ops.ts:requestClientPayment() §key construction.
2. Call `store.insertPendingPayment(row)` — writes `status='pending'` with the UNIQUE key **before** calling the provider. src/payments/payment-ops.ts:requestClientPayment() line ~116.
3. On `IdempotencyCollision`: look up the existing row. If `status='failed'`, reset to pending and retry. If in-flight or succeeded, return early — never fire a second charge. src/payments/payment-ops.ts lines ~118–134.
4. Only after the insert succeeds, call `this.provider.charge(...)`. src/payments/payment-ops.ts:charge().
5. Apply result: mark succeeded/failed on the payment row. State advance is the caller's responsibility (action-applier or webhook handler), not payment-ops. src/payments/payment-ops.ts:applyResult().

**Mockup/media path:**

6. `onRequestMockup()` transitions to `mockup` state **before** calling `generate()` — the order is durably parked even if generation fails. src/brain/action-applier.ts:onRequestMockup().
7. After `generate()` returns URLs, store them in `job_spec`. Do **not** advance to `awaiting_decision` here — host.ts owns that transition after media sends successfully. src/brain/action-applier.ts:onRequestMockup() comment "Do NOT transition here".
8. If bridge returns empty or throws: call `escalateForMockupFailure()` and return a rejection reason. Order stays at `mockup`. SAFETY_GATES.md §"Gate 1 — Invariant".

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "The provider call is fast — crash window is negligible." | SQLite WAL + Baileys at-least-once delivery makes re-entry non-theoretical. The insert costs one row. Source: payment-ops.ts §"INSERT-BEFORE-CHARGE". |
| "Stripe's idempotency key protects against double-charge." | Stripe's key protects the provider side. Without the DB row, `confirmInTransaction` has nothing to CAS on at confirmation time. Source: payment-ops.ts §idempotency_key. |
| "Presenting media and advancing state can be one step." | Gate 1 exists because this was the bug: empty bridge response → order advances → client sees blank `awaiting_decision`. Source: SAFETY_GATES.md §"Gate 1 — The Problem". |

## Red Flags

- `provider.charge()` called before `store.insertPendingPayment()`
- `store.transition(_, 'awaiting_decision')` inside `onRequestMockup()` before media delivery is confirmed
- Idempotency key containing `Math.random()` or a timestamp component
- Empty-URL check absent in the mockup generation path

## Verification

- `SELECT status, idempotency_key FROM payments WHERE order_id = ?` — pending row with deterministic key exists before any Stripe Checkout Session is created
- Simulate crash after insert, before charge; retry: `SELECT COUNT(*) FROM payments WHERE order_id = ? AND kind = 'deposit'` must be 1, not 2
- `SELECT state FROM orders WHERE order_id = ?` = `'mockup'` (not `'awaiting_decision'`) while media is being sent
- `npm test` — test/idempotency-concurrent.test.ts, test/2a-2-empty-return.test.ts
