# Increment 10 — Typecheck Debt

**Branch:** `typecheck-debt` (off `master` @ `23936ac`)
**Date:** 2026-06-18
**Scope:** Resolve 5 known TS non-blockers. Type declarations and union members only — no logic, no behavioral changes.
**Payments path:** untouched — zero diff in `src/payments/`.

---

## Targets resolved

### 1. `"revision"` missing from `PaymentKind` — `src/domain/types.ts:60`

`ClientPaymentKind` (defined in `actions.ts`) includes `"revision"` for the $5 block purchase flow. `PaymentKind` (the store/payment layer type) did not, so assigning `kind: ClientPaymentKind` to `row.kind: PaymentKind` in `payment-ops.ts:106` produced a TS2322 error.

**Before:**
```typescript
export type PaymentKind =
  | "deposit"
  | "balance"
  | "digital"
  | "supplier_deposit"
  | "refund";
```

**After:**
```typescript
export type PaymentKind =
  | "deposit"
  | "balance"
  | "digital"
  | "revision"
  | "supplier_deposit"
  | "refund";
```

---

### 2. `"revision"` missing from `EventType` — `src/domain/types.ts:135`

`recordRevisionEvent()` in `sqlite-store.ts` appends an event with `type: "revision"` for dedup-guarded revision tracking. `EventType` did not include this member, causing TS2322 at `sqlite-store.ts:300`.

**Before:**
```typescript
export type EventType =
  | "state_change" | "msg_sent" | "msg_recv" | "quote_recv"
  | "payment" | "escalation" | "router" | "brain_attempt" | "brain_outcome";
```

**After:**
```typescript
export type EventType =
  | "state_change" | "msg_sent" | "msg_recv" | "quote_recv"
  | "payment" | "escalation" | "revision"
  | "router" | "brain_attempt" | "brain_outcome";
```

---

### 3. `"generate_failed"` missing from `failureType` union — `src/ops/escalation.ts:95`

`escalateForMockupFailure` accepted `"bridge_failed" | "send_failed"`, but three call sites in `action-applier.ts` (lines 410, 473, 638) and one in `host.ts` (line 364) pass `"generate_failed"` for the case where `generate()` throws. Adding the third member makes the union complete.

**Before:**
```typescript
failureType: "bridge_failed" | "send_failed",
```

**After:**
```typescript
failureType: "bridge_failed" | "send_failed" | "generate_failed",
```

No change to call sites; no change to runtime behavior.

---

### 4. `notes?` missing from `mockup_rejected` action — `src/brain/actions.ts:22`

`action-applier.ts` at line 219 reads `action.notes` off the `mockup_rejected` action and passes it to `onMockupRejected(order, notes?: string)`. The Action union member lacked the `notes?` field, so `action.notes` was a TS2339 error.

**Type change (kept):**
```typescript
// before
| { type: "mockup_rejected" }
// after
| { type: "mockup_rejected"; notes?: string }
```

**Coerce (unchanged — runtime behavior preserved):**
```typescript
case "mockup_rejected":
  return { type: "mockup_rejected" };
```

The SOUL contract (`flock-soul-contract.md:137`) defines `mockup_rejected` as `{"type":"mockup_rejected"}` — no `notes` field. The brain is not contracted to emit notes. The coerce therefore stays clean (notes always omitted from the returned object); the type member `notes?: string` is needed only so that `action.notes` at action-applier.ts:219 compiles — at runtime it resolves to `undefined`, which is the same behavior as before.

---

### 5. `applyAll` called with 2 args, signature requires 3 — `src/brain/action-applier.ts:162`

`applyAll(orderId, actions, inboundEventId)` — the third parameter tracks which inbound event triggered the turn (used by `recordRevisionEvent` for dedup). The scheduler calls `applyAll(orderId, actions)` with no inbound event ID (scheduler follow-ups are not triggered by a client message). Many test call sites also omit the third arg.

Fix: default `inboundEventId` to `""`, matching the field initializer `private inboundEventId: string = ''`. No behavioral change — scheduler-triggered revisions were already writing `""` via the field default; now the TypeScript signature agrees.

**Before:**
```typescript
async applyAll(orderId: string, actions: Action[], inboundEventId: string): Promise<ApplyOutcome>
```

**After:**
```typescript
async applyAll(orderId: string, actions: Action[], inboundEventId = ""): Promise<ApplyOutcome>
```

---

## Files changed

| File | Change |
|---|---|
| `src/domain/types.ts` | +`"revision"` to `PaymentKind`; +`"revision"` to `EventType` |
| `src/ops/escalation.ts` | +`"generate_failed"` to `failureType` union in `escalateForMockupFailure` |
| `src/brain/actions.ts` | +`notes?: string` on `mockup_rejected` type member; coerce unchanged (returns `{ type: "mockup_rejected" }`) |
| `src/brain/action-applier.ts` | `inboundEventId: string` → `inboundEventId = ""` |

**Total: 6 insertions, 3 deletions across 4 source files.**

`src/payments/` — **zero diff**. Constraint honoured.

---

## tsc --noEmit result

All 5 target source files clean post-fix:

```
# no output from:
npx tsc --noEmit 2>&1 | grep -E "^src/(brain/action-applier|host|ops/scheduler|payments/payment-ops|store/sqlite-store)"
```

Pre-existing errors in stale vitest test files (`test/2a-*.ts`, `test/2b-*.ts`, etc.) and `src/channel/baileys-adapter.ts` are out of scope for this increment and unchanged.

---

## Test results

| Suite | Command | Result |
|---|---|---|
| Core | `npm test` | **21/21 ✅** |
| Pricing | `npm run test:pricing` | **63/63 ✅** |
| Shipping | `npm run test:shipping` | **46/46 ✅** |
| Element-addressable | `npm run test:element-addressable` | **31/31 ✅** |
| Content-gate | `npm run test:content-gate` | **10/10 ✅** |
| Client-profile | `npm run test:client-profile` | **10/10 ✅** |
| Payment-fork | `npm run test:payment-fork` | **20/20 ✅** |
| FIFO burst | `npx tsx test/fifo-burst.test.ts` | **5/5 ✅** |
| **Total** | | **206/206 ✅** |

**FIFO burst note:** The file contains 5 tests, not 4. The fifth case (`negative control: without JidQueue, same-JID handlers overlap`) was present before this increment — it was a miscount in the CLAUDE.md baseline (`Last verified 2026-06-12: 4/4`). Nothing was added or enabled by this increment.

Five test names (`test/fifo-burst.test.ts`):
1. `same-JID burst: h2 never starts while h1 is running`
2. `cross-JID: two different JIDs run concurrently (not serialized across JIDs)`
3. `poison prevention: error in h1 does not skip h2`
4. `memory cleanup: queue entry removed after drain`
5. `negative control: without JidQueue, same-JID handlers overlap`

Zero regressions. Branch committed for review — do not merge.
