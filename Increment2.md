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
| `local_delivery` + subtotal ≥ $50 + localEligible | $0 |
| `local_delivery` + subtotal ≥ $50 + NOT localEligible | $9.99 |
| `local_delivery` + subtotal < $50 | $9.99 |
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

ZIP allowlist check via env vars:
- `SHOP_ZIP` — shop's home ZIP (must be set to enable local delivery)
- `LOCAL_ZIP_ALLOWLIST` — comma-separated list of eligible ZIPs in the 25mi zone

If `SHOP_ZIP` is unset, logs a TODO warning and returns `false` for all ZIPs (safe default).

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
