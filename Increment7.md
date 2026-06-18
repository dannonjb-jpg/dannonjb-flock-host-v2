# Increment 7 — Payment Fork Verification Report

**Branch:** `payment-fork-verification` (off `element-addressable-spec`)  
**Date:** 2026-06-18  
**Scope:** Verify both post-payment forks (deposit → supplier handoff, $5 digital → AI loop) against the element-addressable spec (Increment 4). Tests only; no production code changes.

---

## 1. Deposit Fork Test Location + Scenario

**File:** `test/payment-fork-verification.test.ts`

Tests covering Part A:

| Test | Lines | Scenario |
|---|---|---|
| `Part A: deposit fork — awaiting_decision → deposit_pending` | ~189–212 | select_mockup B + set_track physical + request_payment deposit → state=deposit_pending, 50% amount correct |
| `Part A: deposit fork — job_spec.elements populated at deposit_pending` | ~214–235 | After payment actions, job_spec.elements has logo_main / product_main / qr_main / text_headline; mockup_urls and selected_mockup present |
| `Part A: deposit fork — revision transitions to supplier-ready` | ~237–270 | Deposit confirmed → revision_note → state=revision; supplier queue called; fulfillment fields (fulfillment_method, delivery_address, shipping_cents) accessible |
| `Part A: deposit fork — job_spec.elements accessible for supplier agent at revision state` | ~272–304 | At revision state, job_spec contains elements array, specs.product_type, and mockup_urls — all fields a supplier agent needs |
| `Part D: deposit fork e2e` | ~380–408 | Full compact flow: awaiting_decision → select → payment → confirm → revision_note → state=revision; supplier queue notified; elements present |

**Supplier-ready state:** `revision` (not `awaiting_supplier_selection` — that state does not exist in this machine). The supplier queue is notified via `SupplierQueue.queueRevision()` when `onRevisionNote` fires on a physical order in `deposit_pending` or `revision` state.

---

## 2. Digital Fork Test Location + Scenario

**File:** `test/payment-fork-verification.test.ts`

| Test | Lines | Scenario |
|---|---|---|
| `Part B: digital fork — awaiting_decision → digital_pending` | ~307–326 | set_track digital + request_payment digital → state=digital_pending; amount=500 cents ($5) |
| `Part B: digital fork — revision_note applies element directives` | ~328–375 | $5 confirmed → revision_note "make the logo bigger" → state=revision; digital_rounds_used=1; generate called with updated logo (1.2x); stored job_spec.elements also updated |
| `Part B: digital fork — final_url set and state=closed after digital_complete` | ~377–401 | Full flow to completion: state=closed; job_spec.final_url points to delivery URL |
| `Part B: digital fork — elements present from template before first revision` | ~403–432 | Legacy order (no pre-existing elements) gets elements initialized from template on first revision_note; "make logo smaller" directive applied (0.8x) |
| `Part D: digital fork e2e` | ~410–440 | Compact full path: awaiting_decision → $5 → confirm → revision delta → digital_complete → closed; final_url set; logo bigger in revision render |

---

## 3. Revision Delta Test (parseRevisionDirectives + applyElementDirectives)

**File:** `test/payment-fork-verification.test.ts`, `test/element-addressable.test.ts`

| Test | File | Location | What it verifies |
|---|---|---|---|
| `Part D: revision delta — 'make logo bigger' → 1.2x size override` | payment-fork-verification | ~442–480 | End-to-end: revision_note fires through action-applier's onRevisionNote → parseRevisionDirectives → applyElementDirectives → patchOrder → generate. job_spec.elements.logo_main.size is exactly 1.2x original. generate() receives the updated order. |
| `parseRevisionDirectives: 'make logo bigger' scales logo_main up by 1.2x` | element-addressable | line 406 | Unit: parseRevisionDirectives output has width/height ≈ 1.2× input |
| `applyElementDirectives: update replaces matching element` | element-addressable | line 452 | Unit: applyElementDirectives replaces by element_id, preserves others |
| `legacy migration: parseRevisionDirectives → applyElementDirectives pipeline` | element-addressable | line 485 | Unit: full pipeline on order with no elements initializes + applies directive |

---

## 4. Content Lock Verification (logo + text)

**File:** `test/payment-fork-verification.test.ts`, `test/element-addressable.test.ts`

| Test | File | What it verifies |
|---|---|---|
| `Part D: content lock — asset_id in elements not written back to job_spec from directive` | payment-fork-verification | After directive pipeline, logo_main.asset_id = undefined, logo_main.content = undefined, text_headline.content = undefined. Compositor never reads these fields — it always fetches logo from AssetStore and text from Order.business_name. |
| `mergeElementSpec: content fields (content, asset_id) ALWAYS from base — locked` | element-addressable | Unit: mergeElementSpec ignores override.asset_id and override.content; base values (or undefined) survive |
| `content lock: logo ALWAYS fetched from AssetStore (resolveLogo called)` | element-addressable | Integration: even when asset_id is injected into elements, SharpCompositor calls resolveLogo() — never reads from element.asset_id |
| `content lock: text ALWAYS from Order row, element.content field never used` | element-addressable | Integration: business_name in Order drives text render; element.content = "WrongBiz" is silently ignored; renders differ with vs without business_name |

---

## 5. Rounds Math Test

**File:** `test/payment-fork-verification.test.ts`

| Test | Location | Scenario |
|---|---|---|
| `Part D: rounds math — 1 block = 3 rounds; 1 used = 2 available` | ~483–523 | 1 succeeded digital payment → block 1. Rounds 1, 2, 3 succeed (digital_rounds_used goes 1→2→3). Round 4 rejected with "no revision rounds available". digital_rounds_used stays at 3 (not incremented on rejection). |
| `Part D: rounds math — succeededDigitalBlocks=0 → revision_note rejected immediately` | ~525–543 | Order in digital_pending with no succeeded payment → revision_note immediately rejected. |
| `Part C: payment confirm → succeededDigitalBlocks increments → rounds unlock` | ~334–350 | Store-level: inserting + confirming digital payment increments succeededDigitalBlocks 0→1. |

**Math verified:** `availableRounds = (succeededDigitalBlocks × 3) − digital_rounds_used`. With 1 block and 1 round used: `(1×3) − 1 = 2 available`. With 3 rounds used: `(1×3) − 3 = 0`, next revision rejected.

---

## 6. Integration Gaps Found

**No blocking gaps.** The following was verified clean:

| Seam | Status |
|---|---|
| Payment webhook → state transition → fork routing | ✅ `confirmInTransaction` / `markPaymentStatus` → `succeededDigitalBlocks` or `hasHeldMoney` drives fork routing correctly |
| Both forks access `job_spec.elements` | ✅ Elements present at `deposit_pending`, `revision`, and `digital_pending`/`revision` |
| Both forks access fulfillment data | ✅ `fulfillment_method`, `delivery_address`, `shipping_cents` readable at all fork states via `patchOrder` |
| Stripe idempotency (deposit + digital) | ✅ Single charge fires; retries reuse existing payment row |
| Failed charge recovery | ✅ Existing core.test.ts guard still passes |
| Digital fork: revision_note without succeeded payment | ✅ Immediately rejected (0 rounds) |
| Deposit fork: `approve_for_print` blocked on uncleared deposit | ✅ Existing core.test.ts guard still passes |

**One structural note (not a gap, but flagged):**  
`succeededRevisionBlocks`, `appliedRevisions`, and `recordRevisionEvent` are called duck-typed on `this.d.store` inside `action-applier.ts` but are NOT declared in the `Store` interface (`src/store/store.ts`). They exist on `SqliteStore` and must be added to any test fake. TypeScript won't catch a missing implementation because `tsx` skips type checking. Recommend adding these three methods to the `Store` interface in a future increment to prevent a silent breakage if someone mocks the store.

---

## 7. Test Results

### `npm run test:payment-fork`
```
20 tests: 20 passed, 0 failed
```

### Full suite (no regressions)
| Suite | Result |
|---|---|
| `npm test` (core.test.ts) | 21/21 passed |
| `npm run test:element-addressable` | 31/31 passed |
| `npm run test:pricing` | 63/63 passed |
| `npm run test:shipping` | 46/46 passed |
| `npm run test:payment-fork` | 20/20 passed |

**Total across all suites: 181 tests, 0 failures.**

---

## 8. Recommendation: Merge-Ready or Fixes Needed?

**Merge-ready.** Both forks work correctly with the element-addressable spec:

- **Deposit fork:** order correctly transitions `awaiting_decision → deposit_pending → revision`; `job_spec.elements` populated from template at first mockup and retained through payment; supplier queue receives the order with elements; fulfillment fields (address, shipping) coexist cleanly.

- **Digital fork:** `$5 → digital_pending → revision` path works; `onRevisionNote` initializes elements from template on legacy orders, applies directives before calling generate (deterministic re-render), and correctly tracks rounds. `digital_complete` writes `final_url` and closes the order.

- **Rounds math:** 1 block = 3 rounds; each revision_note consumes 1; fourth rejected cleanly with no state corruption.

- **Content lock:** logo and text content is never sourced from element spec fields — enforced at the compositor layer (verified in element-addressable.test.ts) and structurally confirmed in the fork pipeline (no asset_id/content written into job_spec by the directive pipeline).

- **No regressions** in any existing test suite.

**One non-blocking item before shipping to production:** Add `succeededRevisionBlocks`, `appliedRevisions`, `recordRevisionEvent` to the `Store` interface so TypeScript enforces their presence on all fakes/mocks at compile time.
