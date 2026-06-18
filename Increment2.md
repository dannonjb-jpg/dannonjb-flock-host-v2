# Increment 2 — Tote Rename + Fulfillment Module

**Branch:** `fulfillment` (off `canonical-pricing`)
**Commit:** `9da1b79`
**Date:** 2026-06-18
**Stripe path:** untouched (zero diff in `src/payments/`)
**Not merged** to master or canonical-pricing.

---

## Part A — bag→tote rename

### What changed

| File | Change |
|---|---|
| `src/pricing/pricing.ts` | `UNIT_BASE_PRICES.bag` → `UNIT_BASE_PRICES.tote`; added `PRODUCT_TYPE_ALIASES`, `normalizeProductType()`; `computePrice()` normalizes type before lookup |
| `scripts/regen-pricing.ts` | `PRODUCT_LABELS.bag` → `PRODUCT_LABELS.tote` |
| `flock-soul-pricing.md` | Regenerated — "Tote Bag" row now sourced from `tote` key (no data change; prices unchanged) |
| `price.md` | Updated product catalog cross-reference (`bag` → `tote`) |

### Backward-compat alias

```typescript
// src/pricing/pricing.ts
export const PRODUCT_TYPE_ALIASES: Record<string, string> = {
  bag: "tote",
};
export function normalizeProductType(type: string): string {
  return PRODUCT_TYPE_ALIASES[type] ?? type;
}
```

`computePrice({ product_type: "bag", ... })` normalizes to `"tote"` before lookup. In-flight orders with `product_type='bag'` in job_spec will price correctly without any DB migration.

### DB migration check

```
sqlite3 flock.db "SELECT COUNT(*) FROM orders
  WHERE json_extract(job_spec, '$.product_type') = 'bag';"
→ 0
```

Zero rows — no DB migration required.

### Test output (pricing)

```
63/63 passed
```

7 new tests added to `test/pricing.test.ts`:
- `tote: qty 1 = $22 (standard price)`
- `tote: standard ladder applies — qty 5 = $99 (0.90x)`
- `tote: qty 25 = $412.50 (0.75x)`
- `bag alias resolves to tote — same price as tote qty 1`
- `bag alias: qty 10 prices correctly (0.90x tier)`
- `normalizeProductType: bag → tote`
- `normalizeProductType: unknown keys pass through unchanged`

---

## Part B — Fulfillment Module (§5.12)

### New file: `src/pricing/shipping.ts`

#### Constants

| Constant | Value | Meaning |
|---|---|---|
| `FREE_SHIP_THRESHOLD_CENTS` | `5000` | $50 PRODUCT subtotal threshold for free standard shipping |
| `SHIP_STANDARD_CENTS` | `999` | $9.99 standard parcel shipping |
| `SHIP_PRIORITY_CENTS` | `1999` | $19.99 priority (2–5 business days) |
| `SHIP_OVERNIGHT_CENTS` | `2499` | $24.99 overnight |
| `LOCAL_RADIUS_MILES` | `25` | Delivery zone radius |

#### `computeShipping(subtotalCents, method, tier, localEligible, productType?, readyToShipDate?)`

Shipping rules implemented:

| Scenario | Result |
|---|---|
| `pickup` | Always $0 |
| `local_delivery` + subtotal ≥ $50 (any eligibility) | $0 — standard-ship fallback |
| `local_delivery` + subtotal < $50 (any eligibility) | $9.99 |
| `ship / standard` + subtotal ≥ $50 | $0 (free threshold) |
| `ship / standard` + subtotal < $50 | $9.99 |
| `ship / priority` (any subtotal) | $19.99 — **always paid** |
| `ship / overnight` (any subtotal) | $24.99 — **always paid** |
| Any method + oversize product | `oversizeEscalation=true`, $0 — manual freight quote required |

**Expedite is always paid** — priority and overnight never become free, even above the $50 threshold.

**Deposit split note:** shipping is added to the order total; the existing 50/50 deposit split applies to the full total (including shipping). Flag for review if shipping should be charged with balance only.

#### `OVERSIZE_PRODUCTS`

```typescript
export const OVERSIZE_PRODUCTS: ReadonlySet<string> = new Set([
  "banner_standard",
  "vinyl_mesh_materials",
]);
```

When `productType` is in this set, `computeShipping` returns `oversizeEscalation: true` and zero shipping — the host must escalate to a manual freight quote before charging.

#### `isLocalEligible(customerZip)`

ZIP allowlist check. Defaults hardcoded; env-overridable:
- `SHOP_ZIP` — defaults to `"78577"` (Pharr, TX)
- `LOCAL_ZIP_ALLOWLIST` — comma-separated override; defaults to RGV core list

Default `LOCAL_ZIP_ALLOWLIST` covers: McAllen (78501–78505), Edinburg (78539/78541/78542), Mission (78572–78574), Pharr (78577), Alamo (78516), Donna (78537), Hidalgo (78557), La Joya (78558), La Villa (78562 ⚠ borderline), Mercedes (78570), San Juan (78589), Valley View (78593 ⚠ borderline), Weslaco (78596).

⚠ **Manual review needed** for 78562 (La Villa, ~20mi) and 78593 (Valley View). Verify with ZIP-centroid dataset before expanding delivery commitments.

#### `computeEtaDays(tier, readyToShipDate, todayIso?)`

ETA clock starts at `readyToShipDate` (agreed project date), NOT order creation. Transit days are added on top:
- `standard`: 7 transit days
- `priority`: 3 transit days
- `overnight`: 1 transit day

`todayIso` is injectable for deterministic testing.

### Schema changes

#### `src/store/order-schema.sql` (new columns)

```sql
-- Fulfillment fields (§5.12) — NULL until fulfillment step
fulfillment_method  TEXT,   -- 'pickup'|'local_delivery'|'ship'
delivery_address    TEXT,   -- free-text; collected at fulfillment step
shipping_tier       TEXT,   -- 'standard'|'priority'|'overnight'
shipping_cents      INTEGER, -- computed by computeShipping(); added to order total
ready_to_ship_date  TEXT,   -- ISO8601 agreed project date; ETA clock starts here

CHECK (fulfillment_method IS NULL OR fulfillment_method IN ('pickup','local_delivery','ship')),
CHECK (shipping_tier IS NULL OR shipping_tier IN ('standard','priority','overnight')),
```

#### `src/store/sqlite-store.ts` — idempotent migration

```typescript
// Runs on every boot; errors silently ignored if columns already exist
for (const stmt of [
  "ALTER TABLE orders ADD COLUMN fulfillment_method TEXT",
  "ALTER TABLE orders ADD COLUMN delivery_address TEXT",
  "ALTER TABLE orders ADD COLUMN shipping_tier TEXT",
  "ALTER TABLE orders ADD COLUMN shipping_cents INTEGER",
  "ALTER TABLE orders ADD COLUMN ready_to_ship_date TEXT",
]) {
  try { this.db.prepare(stmt).run(); } catch { /* column already exists */ }
}
```

The migration was applied to the live `flock.db` and verified:
```
PRAGMA table_info(orders);
→ 23|fulfillment_method|TEXT|0||0
  24|delivery_address|TEXT|0||0
  25|shipping_tier|TEXT|0||0
  26|shipping_cents|INTEGER|0||0
  27|ready_to_ship_date|TEXT|0||0
```

#### `src/domain/types.ts`

```typescript
export type FulfillmentMethod = "pickup" | "local_delivery" | "ship";
export type ShippingTier = "standard" | "priority" | "overnight";

// Added to Order interface:
fulfillment_method: FulfillmentMethod | null;
delivery_address: string | null;
shipping_tier: ShippingTier | null;
shipping_cents: number | null;
ready_to_ship_date: string | null;
```

### Test output (shipping)

```
37/37 passed
```

Full test list (`test/shipping.test.ts`):
- Constants: FREE_SHIP_THRESHOLD_CENTS, SHIP_STANDARD/PRIORITY/OVERNIGHT, LOCAL_RADIUS_MILES
- OVERSIZE_PRODUCTS membership (banner_standard, vinyl_mesh_materials included; tshirt/tote/mug excluded)
- Free-ship boundary: $49.99 NOT free; $50.00 IS free; $50.01 IS free
- Pickup: always free at any subtotal
- ship/standard below threshold = $9.99
- ship/priority below threshold = $19.99
- ship/overnight below threshold = $24.99
- Expedite always paid: priority $19.99 at $50+ subtotal
- Expedite always paid: overnight $24.99 at $50+ subtotal
- Expedite always paid: priority $19.99 at $100 subtotal
- local_delivery: subtotal ≥ $50 AND localEligible → FREE
- local_delivery: subtotal ≥ $50 AND NOT localEligible → $9.99
- local_delivery: subtotal < $50 even if localEligible → $9.99
- local_delivery: subtotal < $50 AND not localEligible → $9.99
- Oversize escalation: banner_standard → oversizeEscalation=true
- Oversize escalation: vinyl_mesh_materials → oversizeEscalation=true
- Oversize escalation: shippingCents=0 when oversize (no auto-charge)
- Oversize escalation: tshirt does NOT trigger oversize flag
- Oversize escalation: applies regardless of pickup method
- computeEtaDays: standard (7) + 3 days until ready = 10 days total
- computeEtaDays: priority (3) + 5 days until ready = 8 days total
- computeEtaDays: overnight (1) + ready today = 1 day
- computeEtaDays: past ready_to_ship_date → max(0,...)+transit = transit only
- etaDays null for pickup
- etaDays null for local_delivery
- etaDays null when no readyToShipDate
- etaDays set for ship + readyToShipDate (≥ priority transit days)
- digital not in OVERSIZE_PRODUCTS (caller guards digital orders)
- digital input treated as standard shippable (no special override inside module)
- isLocalEligible returns false when SHOP_ZIP not set

---

## Diff Summary

| File | Lines +/- | Notes |
|---|---|---|
| `src/pricing/pricing.ts` | +13 / -1 | tote key, alias map, normalizer, computePrice normalize call |
| `src/pricing/shipping.ts` | +129 / 0 | **NEW** — full fulfillment module |
| `src/domain/types.ts` | +9 / 0 | FulfillmentMethod, ShippingTier, 5 new Order fields |
| `src/store/order-schema.sql` | +9 / 0 | 5 new columns + 2 CHECKs |
| `src/store/sqlite-store.ts` | +29 / 0 | 5 fields in PATCHABLE, idempotent migration block |
| `scripts/regen-pricing.ts` | +1 / -1 | bag→tote in PRODUCT_LABELS |
| `flock-soul-pricing.md` | regen | Tote Bag row now from tote key |
| `price.md` | +218 / 0 | **NEW** doc — updated bag→tote refs |
| `test/pricing.test.ts` | +48 / 0 | 7 new tote/alias tests; FakeStore updated for new fields |
| `test/shipping.test.ts` | +254 / 0 | **NEW** — 37 shipping tests |
| `package.json` | +1 / 0 | test:shipping script |

**Total: 709 insertions, 3 deletions across 10 files**

---

## Invariants preserved

- `src/payments/` — zero diff. Stripe charge/webhook path untouched.
- Branch not merged to master or canonical-pricing.
- All pre-existing 56 pricing tests continue to pass (now 63 total).
- `computeShipping` is a pure function — no side effects, injectable for testing.
- DB migration is idempotent — safe to run on boot repeatedly.

---

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
| `selected_mockup` | `"A" | "B" | null` on `orders` row | `onSelectMockup()` `:257` via `patchOrder` | Records client's choice; visible to Penn/operators; not used by compositor |

`succeededDigitalBlocks()` (Store method, called at `:429`) counts `digital` payments with `status=succeeded` — each block of 3 costs $5 and grants 3 more rounds.
