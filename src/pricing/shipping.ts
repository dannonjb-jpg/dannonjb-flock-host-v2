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
// Shop is at 78577 (Pharr, TX). Allowlist computed from RGV centroid geography.
// Override at runtime via env: SHOP_ZIP, LOCAL_ZIP_ALLOWLIST (comma-sep).
//
// DEFAULT_LOCAL_ZIPS: RGV core ZIPs within ~25mi of 78577.
// Derived from known city-ZIP mappings; no external API used.
// ⚠ FLAG FOR MANUAL REVIEW: borderline ZIPs (78562, 78593) are ~20mi — verify
//   with a ZIP-centroid dataset before expanding delivery commitments.

const DEFAULT_LOCAL_ZIPS = [
  // McAllen
  "78501", "78502", "78503", "78504", "78505",
  // Edinburg (~10mi north)
  "78539", "78541", "78542",
  // Mission (~18mi west)
  "78572", "78573", "78574",
  // Pharr — shop home ZIP
  "78577",
  // Alamo (~8mi east)
  "78516",
  // Donna (~12mi east)
  "78537",
  // Hidalgo (~5mi south)
  "78557",
  // La Joya (~15mi northwest)
  "78558",
  // La Villa (~20mi east) ⚠ borderline — verify
  "78562",
  // Mercedes (~22mi east)
  "78570",
  // San Juan (~3mi east)
  "78589",
  // Valley View (~5mi) ⚠ borderline — verify
  "78593",
  // Weslaco (~18mi east)
  "78596",
];

export const SHOP_ZIP: string = process.env["SHOP_ZIP"] ?? "78577";

const LOCAL_ZIPS: ReadonlySet<string> = new Set(
  (process.env["LOCAL_ZIP_ALLOWLIST"] ?? DEFAULT_LOCAL_ZIPS.join(","))
    .split(",").map((z) => z.trim()).filter(Boolean),
);

export function isLocalEligible(customerZip: string): boolean {
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
 * - local_delivery     → same free-ship threshold as standard (FREE at subtotal ≥ $50,
 *                        $9.99 under $50) regardless of localEligible.
 *                        localEligible controls whether to OFFER local delivery; once
 *                        chosen, pricing is identical to ship/standard.
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
    // Pricing follows the standard free-ship rule regardless of zone eligibility.
    // localEligible governs whether to offer local delivery, not what it costs.
    shippingCents = aboveThreshold ? 0 : SHIP_STANDARD_CENTS;
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
