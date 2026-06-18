// src/pricing/shipping.ts
// Fulfillment / shipping computation for physical orders (§5.12).
// Digital orders ($5 flat) never reach this module — caller's guard.

export type FulfillmentMethod = "pickup" | "local_delivery" | "ship";
export type ShippingTier = "standard" | "priority" | "overnight";

// ── constants ─────────────────────────────────────────────────────────────────

export const FREE_SHIP_THRESHOLD_CENTS = 5000;  // $50 PRODUCT subtotal threshold
export const SHIP_STANDARD_CENTS       = 999;   // $9.99
export const SHIP_PRIORITY_CENTS       = 1999;  // $19.99 (2–5 business days)
export const SHIP_OVERNIGHT_CENTS      = 2499;  // $24.99 (next business day)
export const LOCAL_RADIUS_MILES        = 25;

// Transit days (business days) from ship date to delivery, per tier.
const TRANSIT_DAYS: Record<ShippingTier, number> = {
  standard:  7,
  priority:  3,
  overnight: 1,
};

// ── oversize escalation ───────────────────────────────────────────────────────
// Products that cannot ship as standard parcels. When an order contains one of
// these, computeShipping returns oversizeEscalation=true; the host must escalate
// to a manual freight quote rather than auto-charging a standard rate.
export const OVERSIZE_PRODUCTS: ReadonlySet<string> = new Set([
  "banner_standard",
  "vinyl_mesh_materials",
]);

// ── local eligibility ─────────────────────────────────────────────────────────
// ZIP-code allowlist for the shop's 25-mile delivery zone.
// Configured via environment: SHOP_ZIP (single ZIP) + LOCAL_ZIP_ALLOWLIST (comma-sep list).
// TODO: if SHOP_ZIP is unset, log a warning and default to ineligible for all.

const SHOP_ZIP = process.env["SHOP_ZIP"];
const LOCAL_ZIPS: ReadonlySet<string> = new Set(
  (process.env["LOCAL_ZIP_ALLOWLIST"] ?? "").split(",").map((z) => z.trim()).filter(Boolean),
);

export function isLocalEligible(customerZip: string): boolean {
  if (!SHOP_ZIP) {
    // TODO: configure SHOP_ZIP to enable local delivery zone checks
    console.warn("[shipping] SHOP_ZIP not configured — local delivery eligibility cannot be determined; defaulting to ineligible");
    return false;
  }
  return LOCAL_ZIPS.has(customerZip);
}

// ── ETA helper ────────────────────────────────────────────────────────────────
// Returns total business days from today until estimated delivery.
// Clock starts at readyToShipDate (agreed project date), NOT order creation.
// Transit window is added on top of however many days remain until ready-to-ship.

export function computeEtaDays(
  tier: ShippingTier,
  readyToShipDate: string, // ISO8601
  todayIso?: string,       // injectable for deterministic testing
): number {
  const today = new Date(todayIso ?? new Date().toISOString().slice(0, 10));
  const ready = new Date(readyToShipDate);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntilReady = Math.max(0, Math.ceil((ready.getTime() - today.getTime()) / msPerDay));
  return daysUntilReady + TRANSIT_DAYS[tier];
}

// ── computeShipping ───────────────────────────────────────────────────────────

export interface ShippingResult {
  shippingCents: number;
  oversizeEscalation: boolean; // true → manual freight quote required; shippingCents is meaningless
  etaDays: number | null;      // null when method !== "ship" or no readyToShipDate
}

/**
 * Compute shipping cost for a physical order.
 *
 * Rules (flock-canonical.md §5.12):
 * - pickup             → always FREE
 * - local_delivery     → FREE when subtotal ≥ $50 AND localEligible; otherwise $9.99
 * - ship / standard    → FREE when subtotal ≥ $50; otherwise $9.99
 * - ship / priority    → always $19.99 (expedite always paid, even at $50+)
 * - ship / overnight   → always $24.99 (expedite always paid, even at $50+)
 * - oversize product   → oversizeEscalation=true; shipping MUST be quoted manually
 *
 * Deposit split note: shipping is added to order total; the existing 50/50 deposit
 * split applies to the full total (including shipping). Flag for future review if
 * shipping should be charged with balance only.
 */
export function computeShipping(
  subtotalCents: number,
  method: FulfillmentMethod,
  tier: ShippingTier,
  localEligible: boolean,
  productType?: string,
  readyToShipDate?: string,
): ShippingResult {
  if (productType && OVERSIZE_PRODUCTS.has(productType)) {
    return { shippingCents: 0, oversizeEscalation: true, etaDays: null };
  }

  const aboveThreshold = subtotalCents >= FREE_SHIP_THRESHOLD_CENTS;

  let shippingCents: number;

  if (method === "pickup") {
    shippingCents = 0;
  } else if (method === "local_delivery") {
    // Free only when subtotal ≥ $50 AND within the local delivery zone.
    shippingCents = (aboveThreshold && localEligible) ? 0 : SHIP_STANDARD_CENTS;
  } else {
    // method === "ship"
    if (tier === "standard") {
      shippingCents = aboveThreshold ? 0 : SHIP_STANDARD_CENTS;
    } else if (tier === "priority") {
      shippingCents = SHIP_PRIORITY_CENTS; // expedite always paid
    } else {
      shippingCents = SHIP_OVERNIGHT_CENTS; // expedite always paid
    }
  }

  const etaDays =
    method === "ship" && readyToShipDate
      ? computeEtaDays(tier, readyToShipDate)
      : null;

  return { shippingCents, oversizeEscalation: false, etaDays };
}
