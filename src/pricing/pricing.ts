// src/pricing/pricing.ts
// CLIENT PRICES — FLOCK_PRICING_GUIDE.md v3.0 (May 27, 2026)
// This is the host's source of truth for what clients are charged.
// The SOUL contract's pricing section is derived from the same tables.
// Single source of truth: if prices change, update here and flock-soul-pricing.md.
//
// Dan-approval products (vehicle wraps, signage, specialty): escalate — no auto-quote.

export interface PricingInputs {
  product_type?: string;
  quantity?:     number;   // pieces for unit products; 1000-unit runs for flat print
  sqft?:         number;   // for sqft products — or derived from width_ft × height_ft
  width_ft?:     number;
  height_ft?:    number;
  turnaround_days?: number;   // business days. <=3 => 1.5x, 4-7 => 1.2x, >=8/undefined => 1.0x
                              // (replaces ambiguous rush/urgent labels; matches the guide table)
  print_variant?: "with_design" | "print_only";  // business cards only
  cut_type?:     "single" | "layered";            // cut vinyl only
}

export type PricingResult =
  | { ok: true;  priceCents: number; displayPrice: string }
  | { ok: false; requiresDanApproval: true;  productName: string }
  | { ok: false; requiresDanApproval: false; reason: string };

// ── urgency multiplier (driven by turnaround, per the guide table) ────────────
// 1-3 business days = 1.5x ; 4-7 = 1.2x ; 8+ (standard) = 1.0x.
function urgencyMultiplier(days?: number): number {
  if (days == null) return 1.0;        // unknown turnaround => standard, never overcharge silently
  if (days <= 3) return 1.5;
  if (days <= 7) return 1.2;
  return 1.0;
}

// ── unit-priced products: [minQty, pricePerUnit (USD)] tiers ─────────────────
// "At qty N or more you pay this per unit." Pick the highest tier where minQty ≤ qty.
const UNIT_TIERS: Record<string, [number, number][]> = {
  tshirt:      [[1,30],[5,22],[25,18],[100,15]],
  hat:         [[1,35],[5,25],[25,20],[100,16]],
  bag:         [[1,22],[5,18],[25,15],[100,13]],
  mug:         [[1,20],[5,15],[25,12],[100,10]],
  dtf_transfer:[[1, 8],[5, 6],[25, 5],[100, 4]],
  sky_dancer:  [[1,250],[5,200],[25,175]],
  flag:        [[1,45]],  // guide doesn't tier flags; use single price
};

// ── sqft-priced products: [minSqft, pricePerSqft (USD)] tiers ────────────────
const SQFT_TIERS: Record<string, [number, number][]> = {
  banner_standard:     [[0,6.00],[25,5.50],[100,5.00],[300,4.50]],
  banner_uv:           [[0,6.00],[25,5.50],[100,5.00],[300,4.50]],
  vinyl_mesh_materials:[[0,6.00],[25,5.50],[100,5.00],[300,4.50]],
};

// ── flat-print products: exact-run pricing (quantity: totalPriceUSD) ──────────
// Client orders one of the standard quantities. Between tiers: round up to next.
const FLAT_PRINT: Record<string, Record<number, number>> = {
  business_cards_design: { 1000:150, 2500:225, 5000:375 },
  business_cards_print:  { 1000: 38 },
  flyer:                 { 1000:175, 2500:260, 5000:400 },
  tabloid:               { 1000:325, 2500:475, 5000:750 },
  brochure:              { 1000:285, 2500:420, 5000:675 },
  // Stickers: size-dependent — escalate to Penn for quote
};

// Dan-approval products — host escalates, brain never auto-quotes a price
const DAN_APPROVAL: Record<string, string> = {
  business_signage_indoor:         "Indoor Illuminated Sign",
  business_signage_exterior_flat:  "Exterior Flat Sign",
  business_signage_exterior_lit:   "Exterior Illuminated Box Sign",
  channel_letters:                 "Channel Letters",
  monument_pylon:                  "Monument / Pylon Sign",
  vehicle_wrap_partial:            "Partial Vehicle Wrap",
  vehicle_wrap_full:               "Full Vehicle Wrap",
  cut_vinyl:                       "Cut Vinyl",
  social_media_assets:             "Social Media Package",
  sticker:                         "Stickers (size-dependent)",
  packaging:                       "Custom Packaging",
  specialty_fabrication:           "Specialty Fabrication",
};

// ── helpers ───────────────────────────────────────────────────────────────────

function pickTier(tiers: [number, number][], volume: number): number | null {
  let price: number | null = null;
  for (const [min, p] of tiers) {
    if (volume >= min) price = p;
  }
  return price;
}

function pickRunTier(runs: Record<number, number>, qty: number): { runQty: number; total: number } | null {
  const qtys = Object.keys(runs).map(Number).sort((a, b) => a - b);
  // Find smallest standard qty that covers the order
  const match = qtys.find(q => q >= qty);
  if (!match) return null;
  return { runQty: match, total: runs[match]! };
}

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

const MIN_CENTS = 15000; // $150 minimum quote

// ── main entry ────────────────────────────────────────────────────────────────

export function computePrice(inputs: PricingInputs): PricingResult {
  const type = inputs.product_type;
  if (!type) return { ok: false, requiresDanApproval: false, reason: "product_type not yet collected" };

  // Dan-approval check first
  if (DAN_APPROVAL[type]) {
    return { ok: false, requiresDanApproval: true, productName: DAN_APPROVAL[type]! };
  }

  // Digital file-only is a flat $5/block charged by payment-ops (kind='digital',
  // DIGITAL_BLOCK_CENTS). It is never table-priced — guard so it can't fall through
  // to "unknown product_type".
  if (type === "digital") {
    return { ok: false, requiresDanApproval: false, reason: "digital: flat $5/block via payment-ops, not table-priced" };
  }

  const mult = urgencyMultiplier(inputs.turnaround_days);

  // ── unit-priced ───────────────────────────────────────────────────────────
  if (UNIT_TIERS[type]) {
    const qty = inputs.quantity ?? 1;
    const perUnit = pickTier(UNIT_TIERS[type]!, qty);
    if (perUnit == null) return { ok: false, requiresDanApproval: false, reason: "quantity out of range" };
    const gross = perUnit * qty * mult;
    const cents = Math.max(MIN_CENTS, toCents(gross));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  // ── sqft-priced ───────────────────────────────────────────────────────────
  if (SQFT_TIERS[type]) {
    const sqft = inputs.sqft ??
      (inputs.width_ft != null && inputs.height_ft != null ? inputs.width_ft * inputs.height_ft : null);
    if (!sqft || sqft <= 0) {
      return { ok: false, requiresDanApproval: false, reason: "sqft / dimensions not yet collected" };
    }
    const perSqft = pickTier(SQFT_TIERS[type]!, sqft);
    if (perSqft == null) return { ok: false, requiresDanApproval: false, reason: "sqft tier not found" };
    const gross = perSqft * sqft * mult;
    const cents = Math.max(MIN_CENTS, toCents(gross));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  // ── flat print ────────────────────────────────────────────────────────────
  if (type === "business_cards") {
    const variant = inputs.print_variant === "print_only" ? "business_cards_print" : "business_cards_design";
    const qty = inputs.quantity ?? 1000;
    const run = pickRunTier(FLAT_PRINT[variant]!, qty);
    if (!run) return { ok: false, requiresDanApproval: true, productName: `Custom business-card run (${qty})` };
    const cents = Math.max(MIN_CENTS, toCents(run.total * mult));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  if (FLAT_PRINT[type]) {
    const qty = inputs.quantity ?? 1000;
    const run = pickRunTier(FLAT_PRINT[type]!, qty);
    if (!run) return { ok: false, requiresDanApproval: true, productName: `Custom ${type} run (${qty})` };
    const cents = Math.max(MIN_CENTS, toCents(run.total * mult));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  return { ok: false, requiresDanApproval: false, reason: `unknown product_type: ${type}` };
}
