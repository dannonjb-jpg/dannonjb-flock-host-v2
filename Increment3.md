# Increment 3 — Shipping Fixes + job_spec Fact-Find

**Date:** 2026-06-18
**Branch:** `fulfillment` (same, not merged)
**Tests after:** 46/46 shipping passed

---

## Part A — Fulfillment Fixes

### 1. SHOP_ZIP default set to 78577 (Pharr, TX)

`src/pricing/shipping.ts`:
```typescript
export const SHOP_ZIP: string = process.env["SHOP_ZIP"] ?? "78577";
```

Previously `SHOP_ZIP` was `process.env["SHOP_ZIP"]` (no default) — if unset, `isLocalEligible` warned and returned false for all ZIPs.

### 2. LOCAL_ZIP_ALLOWLIST populated with RGV core ZIPs

Hardcoded `DEFAULT_LOCAL_ZIPS` array in `src/pricing/shipping.ts` covers all cities within ~25mi of 78577 (Pharr, TX):

| City | ZIPs | Notes |
|---|---|---|
| McAllen | 78501, 78502, 78503, 78504, 78505 | Core |
| Edinburg | 78539, 78541, 78542 | ~10mi north |
| Mission | 78572, 78573, 78574 | ~18mi west |
| Pharr | 78577 | Shop home |
| Alamo | 78516 | ~8mi east |
| Donna | 78537 | ~12mi east |
| Hidalgo | 78557 | ~5mi south |
| La Joya | 78558 | ~15mi northwest |
| La Villa | 78562 | ~20mi east ⚠ borderline |
| Mercedes | 78570 | ~22mi east |
| San Juan | 78589 | ~3mi east |
| Valley View | 78593 | ~5mi ⚠ borderline |
| Weslaco | 78596 | ~18mi east |

Env-overridable: set `LOCAL_ZIP_ALLOWLIST` to a comma-separated list to replace defaults entirely.

⚠ **78562 and 78593 flagged for manual review** — verify against ZIP-centroid dataset before committing delivery to those areas.

### 3. local_delivery pricing bug fixed

**Before (wrong):**
```typescript
shippingCents = (aboveThreshold && localEligible) ? 0 : SHIP_STANDARD_CENTS;
```
This charged $9.99 when subtotal ≥ $50 but customer was not in the local zone — which is the standard-ship rule anyway, so it should be free.

**After (correct):**
```typescript
shippingCents = aboveThreshold ? 0 : SHIP_STANDARD_CENTS;
```
`localEligible` governs whether to _offer_ local delivery, not what it costs once chosen. Pricing is identical to ship/standard: free at ≥$50, $9.99 under.

### 4. Test updates

- Fixed test: `"local_delivery: subtotal >= $50 but NOT localEligible = paid ($9.99)"` corrected to expect `$0`
- Added: `"local_delivery: $50+ ineligible → $0 (the explicit boundary case)"`
- Added: `"local_delivery: $49.99 ineligible → $9.99 (below threshold, either eligibility)"`
- Added: 8 new `isLocalEligible` tests covering SHOP_ZIP default, McAllen/Edinburg/Mission/other RGV ZIPs, non-RGV ZIPs, Laredo negative test

Total: **46/46 passed** (up from 37)

### 5. 50/50 deposit — no change

Confirmed as-is: deposit is 50% of full total including shipping. No code change.

---

## Part B — job_spec Fact-Find (Read-Only)

**No code was modified in this section.**

### 1. job_spec schema

Two `JobSpec` definitions coexist:

**`src/domain/types.ts:117`** — domain view: `{ [k: string]: unknown }` — fully open, no fields enforced.

**`src/integrations/sharp-compositor.ts:285–297`** — compositor's typed view:
```typescript
interface JobSpec {
  specs?: {
    description?: string
    product_type?: string
    colors?: string[]
    qr_content?: string
  }
  theme?: string
  style?: string
  color_palette?: string[]
  [k: string]: unknown
}
```

**Fields written at runtime by `action-applier.ts`** (not in either interface, written by string key):

| Field | Written by | Line |
|---|---|---|
| `specs.*` | `onCollect()` — all `collect` fields land in `spec.specs` | `:159` |
| `price_cents` | `onCollect()` after pricing | `:166` |
| `last_brief` | `onRequestMockup`, `onMockupRejected`, `onRevisionNote` | `:249, :306, :455` |
| `mockup_urls` | `onRequestMockup`, `onMockupRejected`, `onRevisionNote` | `:248, :305, :454` |
| `final_url` | `onDigitalComplete` | `:490` |

Full runtime shape: `{ specs: { description?, product_type?, colors?, qr_content?, ...anything else collected }, price_cents?, last_brief?, mockup_urls?: { A?, B? }, final_url? }`

### 2. How sharp-compositor.ts renders from job_spec

**All element placements (logo position/size, text position/size/font/color) come from the template, not job_spec.**

The `REGISTRY` at `:276–279` holds two templates (`banner_standard`, `generic`). `pickTemplate()` at `:344–349` reads `spec.specs?.product_type` and falls to `generic` for everything else.

job_spec provides **data inputs only**:
- `spec.specs?.product_type` → template selection
- `spec.specs?.colors ?? spec.color_palette` → palette (`resolvePalette()`, `:305–313`)
- `spec.specs?.qr_content` → QR URL for the `qr` region (`:415–418`)

### 3. Logo and text in job_spec

**Logo:** Not in job_spec. `placeRegion()` (`:381`) fetches the logo directly from the asset store: `this.assetStore.resolveLogo(order.whatsapp_jid, 'current')`. job_spec has no logo field.

**Text:** `renderTextSvg()` (`:441–471`) reads text content from the Order row — `order.client_name` or `order.business_name` — based on the template's `TextSpec.source` field. Position, font size (`fontFrac`), color (`colorKey`), and weight are all baked into the template's `TextSpec`.

### 4. Element addressability

**No element addressability today.** Placements are entirely template-fixed. No runtime override path exists for position, font, color, or size from job_spec or any other input. The only variable inputs at render time are: which template (via `product_type`), palette colors, whether QR renders (via `qr_content` presence), and text content (from Order row).

### 5. Digital revision loop — what mutates, determinism

`onRevisionNote()` at `action-applier.ts:407` (digital track):
1. Increments `order.digital_rounds_used` (`:439`)
2. Calls `mockups.generate(cur, "both", note)` — note is the new brief (`:447`)
3. Replaces `spec.mockup_urls` and `spec.last_brief` with new values (`:454–456`)
4. `patchOrder` with updated job_spec (`:456`)

**Not deterministic.** Sharp compositing is deterministic given fixed inputs, but the brief changes with each revision — so outputs intentionally differ. No seeded RNG, no render caching.

### 6. Revision counters and selected_mockup

| Field | Type | Where stored | How used |
|---|---|---|---|
| `failed_mockup_pairs` | `INTEGER` on `orders` row | `action-applier.ts:268` increments; `orders` table stores | Checked against `MOCKUP_PAIR_LIMIT=4` (`:50`); at limit → `mockup_pairs` escalation |
| `digital_rounds_used` | `INTEGER` on `orders` row | `action-applier.ts:431` reads; `:439` increments | Available rounds = `succeededBlocks * 3 - roundsUsed`; 0 available → "offer $5 block" |
| `selected_mockup` | `"A" \| "B" \| null` on `orders` row | `onSelectMockup()` `:257` via `patchOrder` | Records client's choice; visible to Penn/operators; not used by compositor |

`succeededDigitalBlocks()` (Store method, called at `:429`) counts `digital` payments with `status=succeeded` — each block of 3 costs $5 and grants 3 more rounds.
