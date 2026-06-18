# Increment 5 — Content Gate

Branch: `content-gate` (off `fulfillment`). Do not merge.

Tests: 10/10 content-gate, 21/21 core — zero regressions.

---

## Part A — `moderateAsset` function

**`src/moderation/moderate.ts`** (new file, 46 lines)

- **`EXPLICIT` patterns** `:15–22` — 6 regexes covering pornographic content, nudity, `explicit`, nsfw, adult content, xxx
- **`HATE_SPEECH` patterns** `:24–29` — 4 regexes covering nazi salutes, white supremacy, gas the X, kill/die variants
- **`moderateAsset(asset)`** `:38–48` — converts bytes to latin1 (lossless binary scan), runs both lists, returns `{ ok, reason? }`. Async signature leaves room for a vision-API replacement without changing callers.

---

## Part B — `ip_attestation` and `moderation_flag` in `JobSpec`

**`src/domain/types.ts`**:
- `OrderState` union — `"shop_rejected"` added `:23`
- `TERMINAL_STATES` — `"shop_rejected"` added `:31`
- `Order.shop_rejected_reason: string | null` `:80`
- `JobSpec.ip_attestation` `:121–126` — `{ attested_at, client_confirms_rights, prompt_shown }`
- `JobSpec.moderation_flag` `:128–132` — `{ flagged, reason?, checked_at }`

**`src/brain/action-applier.ts`** `:160–161` — `onCollect` intercepts `ip_attestation` field and stores it at `spec.ip_attestation` (not `spec.specs`), so the brain can attest via a `collect` action.

---

## Part C — Calibration logic in `onConfirmAsset`

**`src/brain/action-applier.ts`** `:201–244`:
- `resolveAssetById(focus.asset_id)` `:209` — fetch bytes before confirming
- Scan via `moderateAsset` `:211`; record `moderation_flag` in job_spec `:213–218`
- If flagged **and** `ip_attestation.client_confirms_rights === true` `:221–233` → proceed + `postToPenn("[flagged-and-attested] ...")` (non-blocking)
- If flagged **and** no attestation `:234–237` → return rejection reason; `confirmAssetRole` is never called
- Clean → fall through to `confirmAssetRole` as before `:240–243`

Import added `:11`: `import { moderateAsset } from "../moderation/moderate.js";`

---

## Part D — `shop_rejected` refund path

**`src/domain/state-machine.ts`**:
- `shop_rejected: []` in `TRANSITIONS` `:27` — terminal, no exits
- Cross-cutting rule `:55`: `if (to === "shop_rejected") return !isTerminal(from)` — any non-terminal → `shop_rejected`

**`src/store/order-schema.sql`**:
- State CHECK includes `'shop_rejected'` `:74`
- `shop_rejected_reason TEXT` column `:66`

**`src/store/sqlite-store.ts`**:
- `"ALTER TABLE orders ADD COLUMN shop_rejected_reason TEXT"` in migration loop `:80`
- `"shop_rejected_reason"` in `PATCHABLE` array `:54`

**`src/store/store.ts`** `:90–91` — `succeededRevisionBlocks` added to the `Store` interface (was missing, causing a pre-existing TS error in `payment-ops.ts`).

**`src/payments/payment-ops.ts`** `:175–217` — `issueRefund(order, method)`:
- Sums all `direction=in, status=succeeded` payments
- Inserts `direction=out, kind=refund` with idempotency key `{order_id}:refund:shop_rejected`
- Calls existing `charge()` + `applyResult()` (no new code paths)

**`src/ops/shop-reject.ts`** (new file, 52 lines) — `shopRejectOrder(store, payments, notifier, orderId, reason, refundMethod)`:
- Validates non-terminal `:30–31`
- Transitions to `shop_rejected` `:34`, patches `shop_rejected_reason` `:35`
- Calls `issueRefund` if `hasHeldMoney` `:38–45`
- `postToPenn("[shop_rejected] ...")` `:47` non-blocking

**`src/store/asset-store.ts`** `:380–395` — `resolveAssetById(assetId)` added: fetches bytes+metadata by UUID for the moderation gate.

---

## Part E — Tests

**`test/content-gate.test.ts`** — 10 scenarios, all passing:

| # | Scenario | What it exercises |
|---|---|---|
| 1 | clean bytes → ok:true | baseline moderateAsset pass |
| 2 | "explicit" bytes → flagged | EXPLICIT pattern list |
| 3 | "heil hitler" bytes → flagged | HATE_SPEECH pattern list |
| 4 | "nsfw" bytes → flagged | second EXPLICIT pattern |
| 5 | ActionApplier confirm_asset clean | clean path end-to-end |
| 6 | ActionApplier flagged, no attestation | rejection + no confirmAssetRole call |
| 7 | ActionApplier flagged + attested | proceeds + Penn calibration alert |
| 8 | `shop_rejected` in TERMINAL_STATES | Part B/D type invariant |
| 9 | `canTransition` rules for shop_rejected | state machine coverage |
| 10 | `shopRejectOrder` full flow | transition + refund + Penn notification |

---

## Files changed

| File | Change |
|---|---|
| `src/moderation/moderate.ts` | new — keyword/regex blocklist scanner |
| `src/ops/shop-reject.ts` | new — `shopRejectOrder` CLI/internal trigger |
| `test/content-gate.test.ts` | new — 10 test scenarios |
| `src/domain/types.ts` | `shop_rejected` state, `ip_attestation`, `moderation_flag`, `shop_rejected_reason` |
| `src/domain/state-machine.ts` | `shop_rejected` in TRANSITIONS + cross-cutting rule |
| `src/store/order-schema.sql` | `shop_rejected` in CHECK, `shop_rejected_reason` column |
| `src/store/sqlite-store.ts` | ALTER TABLE migration + PATCHABLE entry |
| `src/store/store.ts` | `succeededRevisionBlocks` added to Store interface |
| `src/store/asset-store.ts` | `resolveAssetById` method for moderation gate |
| `src/brain/action-applier.ts` | `moderateAsset` import, `onCollect` ip_attestation, `onConfirmAsset` async + gate |
| `src/payments/payment-ops.ts` | `issueRefund` method |
| `test/core.test.ts` | `succeededRevisionBlocks` + `shop_rejected_reason` in FakeStore |
