// scripts/regen-pricing.ts
// Regenerates flock-soul-pricing.md from the canonical constants in pricing.ts.
// Run: npm run regen-pricing
// The markdown is a GENERATED artifact — never hand-edit pricing numbers there.

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  UNIT_TIERS, SQFT_TIERS, FLAT_PRINT, DAN_APPROVAL,
  MIN_CENTS, UV_UPCHARGE_PER_SQFT,
  CUT_VINYL_BASE_PER_SQFT, CUT_VINYL_LAYER_UPCHARGE, CUT_VINYL_MIN_CENTS,
} from "../src/pricing/pricing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "flock-soul-pricing.md");

const PRODUCT_LABELS: Record<string, string> = {
  tshirt:       "T-Shirt (DTF)",
  hat:          "Hat (Embroidered)",
  bag:          "Tote Bag",
  mug:          "Ceramic Mug (11oz)",
  dtf_transfer: "DTF Transfer",
  tumbler:      "Tumbler",
  sky_dancer:   "Sky Dancer / Inflatable",
  flag:         "Custom Flag",
};

const FLAT_LABELS: Record<string, string> = {
  business_cards_design: "Business Cards (with design)",
  business_cards_print:  "Business Cards (print only, art supplied)",
  flyer:                 "Flyers 8.5×11 double-sided",
  tabloid:               "Tabloid 11×17 double-sided",
  brochure:              "Brochure / Trifold",
  sticker:               "Stickers 2\" circle",
};

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

function unitTable(): string {
  const lines: string[] = [];
  lines.push("| Product | 1 | 5 | 25 | 100 |");
  lines.push("|---|---|---|---|---|");
  for (const [key, tiers] of Object.entries(UNIT_TIERS)) {
    const label = PRODUCT_LABELS[key] ?? key;
    const at = (qty: number) => {
      const p = tiers.filter(([min]) => min <= qty).at(-1)?.[1];
      return p != null ? `$${p}` : "—";
    };
    lines.push(`| ${label} | ${at(1)} | ${at(5)} | ${at(25)} | ${at(100)} |`);
  }
  return lines.join("\n");
}

function flatTable(): string {
  const allQtys = new Set<number>();
  for (const runs of Object.values(FLAT_PRINT)) {
    for (const q of Object.keys(runs)) allQtys.add(Number(q));
  }
  const qtys = [...allQtys].sort((a, b) => a - b);
  const header = `| Product | ${qtys.join(" | ")} |`;
  const sep    = `|${Array(qtys.length + 1).fill("---").join("|")}|`;
  const rows: string[] = [];
  for (const [key, runs] of Object.entries(FLAT_PRINT)) {
    const label = FLAT_LABELS[key] ?? key;
    const cols = qtys.map(q => runs[q] != null ? `$${runs[q]}` : "—");
    rows.push(`| ${label} | ${cols.join(" | ")} |`);
  }
  return [header, sep, ...rows].join("\n");
}

function sqftTable(): string {
  const lines: string[] = [];
  lines.push("| Sqft | Price/sqft |");
  lines.push("|---|---|");
  for (const [min, price] of SQFT_TIERS["banner_standard"]!) {
    const label = min === 0 ? "Under 25" : min === 300 ? "300+" : `${min}–${min === 25 ? 99 : 299}`;
    lines.push(`| ${label} | $${price.toFixed(2)} |`);
  }
  return lines.join("\n");
}

const lines: string[] = [];

lines.push("<!-- AUTO-GENERATED — do not hand-edit. Run: npm run regen-pricing -->");
lines.push("# Flock Pricing — Authoritative Tables");
lines.push("");
lines.push(`*Generated from \`src/pricing/pricing.ts\` · USD · USA clients only*`);
lines.push("");
lines.push("-----");
lines.push("");
lines.push("## Apparel & Promotional");
lines.push("");
lines.push(unitTable());
lines.push("");
lines.push("-----");
lines.push("");
lines.push("## Flat Print");
lines.push("");
lines.push(flatTable());
lines.push("");
lines.push("Print runs come in the quantities shown. If a client asks for an in-between quantity,");
lines.push("quote the next tier up. Stickers: 2\" circle only; other sizes → escalate to Dan.");
lines.push("Business Cards (print only): 1,000 minimum, no 100/500 sub-runs.");
lines.push("");
lines.push("-----");
lines.push("");
lines.push("## Large Format — per square foot");
lines.push("");
lines.push("**Vinyl Banner (13oz) · Vinyl Mesh / Microperforated:**");
lines.push("Same tier table applies to both `banner_standard` and `vinyl_mesh_materials`.");
lines.push("");
lines.push(sqftTable());
lines.push("");
lines.push(`**UV resistance upcharge:** +$${UV_UPCHARGE_PER_SQFT}/sqft post-print on banners or mesh.`);
lines.push("Not urgency-scaled. Set \`uv_resistant=true\` in specs.");
lines.push("*Grommets and hem included on banners.*");
lines.push("");
lines.push("-----");
lines.push("");
lines.push("## Cut Vinyl");
lines.push("");
lines.push(`Base: $${CUT_VINYL_BASE_PER_SQFT}/sqft · +$${CUT_VINYL_LAYER_UPCHARGE}/sqft per additional color/layer · Transfer tape included.`);
lines.push(`Minimum: $${CUT_VINYL_MIN_CENTS / 100}. Urgency multiplier applies to base print cost.`);
lines.push("");
lines.push("-----");
lines.push("");
lines.push("## Urgency Multipliers");
lines.push("");
lines.push("| Turnaround | Multiplier |");
lines.push("|---|---|");
lines.push("| 1–3 business days | 1.5× |");
lines.push("| 4–7 business days | 1.2× |");
lines.push("| 8+ business days (standard) | 1.0× |");
lines.push("");
lines.push("Apply urgency on top of the base price. Always mention the multiplier when quoting rush.");
lines.push("");
lines.push("-----");
lines.push("");
lines.push("## Deposit & Payment Terms");
lines.push("");
lines.push("- **50% deposit** to begin — required before any work starts");
lines.push("- **50% balance** before delivery");
lines.push("- **Digital file only** (no print): $5 flat on any product");
lines.push("- **Revisions**: 3 free · $5 per additional round (block of 3)");
lines.push(`- **Minimum quote**: ${usd(MIN_CENTS)} (physical; digital $5 flat is separate)`);
lines.push("");
lines.push("-----");
lines.push("");
lines.push("## Products Requiring Dan Approval — Do Not Auto-Quote");
lines.push("");
lines.push('For the following, tell the client: *"Let me put together an exact quote for you — I\'ll follow up shortly."* Then escalate.');
lines.push("");
for (const [, name] of Object.entries(DAN_APPROVAL)) {
  lines.push(`- ${name}`);
}

writeFileSync(out, lines.join("\n") + "\n");
console.log(`[regen-pricing] wrote ${out}`);
