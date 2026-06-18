// src/pricing/pricing.ts
// CLIENT PRICES — single source of truth for what clients are charged.
// flock-soul-pricing.md is GENERATED from these constants via `npm run regen-pricing`.
// Do not hand-edit the markdown; edit here and regenerate.
//
// Dan-approval products (vehicle wraps, signage, specialty): escalate — no auto-quote.

export interface PricingInputs {
  product_type?: string;
  quantity?:     number;   // pieces for unit products; run size for flat print
  sqft?:         number;   // for sqft products — or derived from width_ft × height_ft
  width_ft?:     number;
  height_ft?:    number;
  turnaround_days?: number;   // business days. <=3 => 1.5x, 4-7 => 1.2x, >=8/undefined => 1.0x
                              // (replaces ambiguous rush/urgent labels; matches the guide table)
  print_variant?: "with_design" | "print_only";  // business cards only
  num_colors?:   number;   // cut vinyl: 1 = single color, 2+ adds $2/sqft per additional layer
  uv_resistant?: boolean;  // banner/mesh post-print UV upcharge: +$2/sqft flat, not urgency-scaled
}

export type PricingResult =
  | { ok: true;  priceCents: number; displayPrice: string }
  | { ok: false; requiresDanApproval: true;  productName: string }
  | { ok: false; requiresDanApproval: false; reason: string };

// ── urgency multiplier ────────────────────────────────────────────────────────
// 1-3 business days = 1.5x ; 4-7 = 1.2x ; 8+ (standard) = 1.0x.
function urgencyMultiplier(days?: number): number {
  if (days == null) return 1.0;        // unknown turnaround => standard, never overcharge silently
  if (days <= 3) return 1.5;
  if (days <= 7) return 1.2;
  return 1.0;
}

// ── standard unit-discount ladder ────────────────────────────────────────────
// Shared [minQty, multiplier] breakpoints used by all unit-priced products unless
// overridden. Selection: pick the highest tier where minQty ≤ qty.
export const UNIT_LADDER: [number, number][] = [
  [1,   1.00],
  [5,   0.90],
  [25,  0.75],
  [100, 0.65],
  [500, 0.55],
];

// Base prices (qty-1 USD) for unit-priced products.
export const UNIT_BASE_PRICES: Record<string, number> = {
  tshirt:        30,
  hat:           35,
  tote:          22,
  mug:           20,
  dtf_transfer:   8,
  tumbler:       40,
};

// Per-product override: a custom [minQty, multiplier] table replaces UNIT_LADDER
// for that product. Empty for all current products; reserved for future use.
export const UNIT_LADDER_OVERRIDES: Record<string, [number, number][]> = {};

// Legacy product_type aliases — normalize before lookup so in-flight "bag" orders price.
export const PRODUCT_TYPE_ALIASES: Record<string, string> = {
  bag: "tote",
};

export function normalizeProductType(type: string): string {
  return PRODUCT_TYPE_ALIASES[type] ?? type;
}

// ── sqft-priced products ──────────────────────────────────────────────────────
// banner_uv removed — UV resistance is now a +$2/sqft post-print upcharge (UV_UPCHARGE_PER_SQFT),
// not a standalone product. Pass uv_resistant=true on banner_standard or vinyl_mesh_materials.
export const SQFT_TIERS: Record<string, [number, number][]> = {
  banner_standard:     [[0,6.00],[25,5.50],[100,5.00],[300,4.50]],
  vinyl_mesh_materials:[[0,6.00],[25,5.50],[100,5.00],[300,4.50]],
};

// UV resistance post-print upcharge: flat per sqft, not urgency-scaled.
export const UV_UPCHARGE_PER_SQFT = 2;

// ── cut vinyl ─────────────────────────────────────────────────────────────────
// Auto-priced. Transfer tape included. Urgency multiplier applies to base print cost.
export const CUT_VINYL_BASE_PER_SQFT   = 8;
export const CUT_VINYL_LAYER_UPCHARGE  = 2;   // +$2/sqft per additional color/layer
export const CUT_VINYL_MIN_CENTS       = 4000; // $40 minimum (not the global MIN_CENTS)

// ── flat-print products: exact-run pricing (quantity → totalPriceUSD) ─────────
// Standard runs: pick the smallest tier that covers the order quantity.
// BC/flyer/tabloid/brochure: 100-run = 30% of 1000 price; 500-run = 75% of 1000 price.
// BC print-only: 1000 minimum, no 100/500 sub-runs.
// Sticker: 2" circle only, 1000 minimum, no sub-runs.
export const FLAT_PRINT: Record<string, Record<number, number>> = {
  business_cards_design: { 100:45, 500:112.5, 1000:150, 2500:225, 5000:375 },
  business_cards_print:  { 1000:39 },
  flyer:                 { 100:52.5, 500:131.25, 1000:175, 2500:260, 5000:400 },
  tabloid:               { 100:97.5, 500:243.75, 1000:325, 2500:475, 5000:750 },
  brochure:              { 100:85.5, 500:213.75, 1000:285, 2500:420, 5000:675 },
  sticker:               { 1000:90 },  // 2" circle; other sizes escalate to Dan
};

// Dan-approval products — host escalates, brain never auto-quotes a price.
// flag and sky_dancer are parked here pending clean pricing numbers; history preserved.
export const DAN_APPROVAL: Record<string, string> = {
  business_signage_indoor:         "Indoor Illuminated Sign",
  business_signage_exterior_flat:  "Exterior Flat Sign",
  business_signage_exterior_lit:   "Exterior Illuminated Box Sign",
  channel_letters:                 "Channel Letters",
  monument_pylon:                  "Monument / Pylon Sign",
  vehicle_wrap_partial:            "Partial Vehicle Wrap",
  vehicle_wrap_full:               "Full Vehicle Wrap",
  social_media_assets:             "Social Media Package",
  packaging:                       "Custom Packaging",
  specialty_fabrication:           "Specialty Fabrication",
  feather_flag:                    "Feather Flag (sizes pending — escalate for quote)",
  flag:                            "Custom Flag (pricing pending — escalate for quote)",
  sky_dancer:                      "Sky Dancer / Inflatable (pricing pending — escalate for quote)",
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

// Round to the nearest $0.05 (5 cents). Applied to all auto-computed prices.
export function roundToNickel(cents: number): number {
  return Math.round(cents / 5) * 5;
}

export const MIN_CENTS = 2000; // $20 physical floor

// ── main entry ────────────────────────────────────────────────────────────────

export function computePrice(inputs: PricingInputs): PricingResult {
  const type = inputs.product_type ? normalizeProductType(inputs.product_type) : inputs.product_type;
  if (!type) return { ok: false, requiresDanApproval: false, reason: "product_type not yet collected" };

  // Dan-approval check first (includes parked products: flag, sky_dancer)
  if (DAN_APPROVAL[type]) {
    return { ok: false, requiresDanApproval: true, productName: DAN_APPROVAL[type]! };
  }

  // Digital file-only is a flat $5/block charged by payment-ops (kind='digital',
  // DIGITAL_BLOCK_CENTS). It is never table-priced — guard so it can't fall through.
  if (type === "digital") {
    return { ok: false, requiresDanApproval: false, reason: "digital: flat $5/block via payment-ops, not table-priced" };
  }

  const mult = urgencyMultiplier(inputs.turnaround_days);

  // ── unit-priced ───────────────────────────────────────────────────────────
  // Uses UNIT_LADDER (shared) unless the product has an entry in UNIT_LADDER_OVERRIDES.
  const basePrice = UNIT_BASE_PRICES[type];
  if (basePrice != null) {
    const qty = inputs.quantity ?? 1;
    const ladder = UNIT_LADDER_OVERRIDES[type] ?? UNIT_LADDER;
    const discount = pickTier(ladder, qty);
    if (discount == null) return { ok: false, requiresDanApproval: false, reason: "quantity out of range" };
    const gross = basePrice * discount * qty * mult;
    const cents = roundToNickel(Math.max(MIN_CENTS, toCents(gross)));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  // ── cut vinyl ─────────────────────────────────────────────────────────────
  // Urgency multiplier on base print; $40 minimum (overrides global MIN_CENTS).
  if (type === "cut_vinyl") {
    const sqft = inputs.sqft ??
      (inputs.width_ft != null && inputs.height_ft != null ? inputs.width_ft * inputs.height_ft : null);
    if (!sqft || sqft <= 0) {
      return { ok: false, requiresDanApproval: false, reason: "sqft / dimensions not yet collected" };
    }
    const extraLayers = Math.max(0, (inputs.num_colors ?? 1) - 1);
    const perSqft = CUT_VINYL_BASE_PER_SQFT + extraLayers * CUT_VINYL_LAYER_UPCHARGE;
    const gross = perSqft * sqft * mult;
    const cents = roundToNickel(Math.max(CUT_VINYL_MIN_CENTS, toCents(gross)));
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
    const baseGross = perSqft * sqft * mult;
    // UV post-print upcharge: flat per sqft, not urgency-scaled (independent treatment step).
    const uvUpcharge = inputs.uv_resistant ? UV_UPCHARGE_PER_SQFT * sqft : 0;
    const cents = roundToNickel(Math.max(MIN_CENTS, toCents(baseGross + uvUpcharge)));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  // ── flat print ────────────────────────────────────────────────────────────
  if (type === "business_cards") {
    const variant = inputs.print_variant === "print_only" ? "business_cards_print" : "business_cards_design";
    const qty = inputs.quantity ?? 1000;
    const run = pickRunTier(FLAT_PRINT[variant]!, qty);
    if (!run) return { ok: false, requiresDanApproval: true, productName: `Custom business-card run (${qty})` };
    const cents = roundToNickel(Math.max(MIN_CENTS, toCents(run.total * mult)));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  if (FLAT_PRINT[type]) {
    const qty = inputs.quantity ?? 1000;
    const run = pickRunTier(FLAT_PRINT[type]!, qty);
    if (!run) return { ok: false, requiresDanApproval: true, productName: `Custom ${type} run (${qty})` };
    const cents = roundToNickel(Math.max(MIN_CENTS, toCents(run.total * mult)));
    return { ok: true, priceCents: cents, displayPrice: `$${(cents / 100).toFixed(2)}` };
  }

  return { ok: false, requiresDanApproval: false, reason: `unknown product_type: ${type}` };
}
