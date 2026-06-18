// test/shipping.test.ts
// Tests for src/pricing/shipping.ts (§5.12 fulfillment).
// Run: npx tsx test/shipping.test.ts

import assert from "node:assert";
import {
  computeShipping,
  computeEtaDays,
  isLocalEligible,
  FREE_SHIP_THRESHOLD_CENTS,
  SHIP_STANDARD_CENTS,
  SHIP_PRIORITY_CENTS,
  SHIP_OVERNIGHT_CENTS,
  LOCAL_RADIUS_MILES,
  OVERSIZE_PRODUCTS,
  SHOP_ZIP,
} from "../src/pricing/shipping.js";

// ── harness ───────────────────────────────────────────────────────────────────

let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ── constants ─────────────────────────────────────────────────────────────────

test("FREE_SHIP_THRESHOLD_CENTS = 5000 ($50)", () => {
  assert.equal(FREE_SHIP_THRESHOLD_CENTS, 5000);
});

test("SHIP_STANDARD_CENTS = 999", () => {
  assert.equal(SHIP_STANDARD_CENTS, 999);
});

test("SHIP_PRIORITY_CENTS = 1999", () => {
  assert.equal(SHIP_PRIORITY_CENTS, 1999);
});

test("SHIP_OVERNIGHT_CENTS = 2499", () => {
  assert.equal(SHIP_OVERNIGHT_CENTS, 2499);
});

test("LOCAL_RADIUS_MILES = 25", () => {
  assert.equal(LOCAL_RADIUS_MILES, 25);
});

test("OVERSIZE_PRODUCTS contains banner_standard and vinyl_mesh_materials", () => {
  assert.ok(OVERSIZE_PRODUCTS.has("banner_standard"));
  assert.ok(OVERSIZE_PRODUCTS.has("vinyl_mesh_materials"));
});

test("OVERSIZE_PRODUCTS does not include standard apparel products", () => {
  assert.ok(!OVERSIZE_PRODUCTS.has("tshirt"));
  assert.ok(!OVERSIZE_PRODUCTS.has("tote"));
  assert.ok(!OVERSIZE_PRODUCTS.has("mug"));
});

// ── free-ship boundary ($49.99 vs $50) ───────────────────────────────────────

test("standard shipping: subtotal $49.99 (4999¢) is NOT free", () => {
  const r = computeShipping(4999, "ship", "standard", false);
  assert.equal(r.shippingCents, SHIP_STANDARD_CENTS);
  assert.ok(!r.oversizeEscalation);
});

test("standard shipping: subtotal $50.00 (5000¢) IS free", () => {
  const r = computeShipping(5000, "ship", "standard", false);
  assert.equal(r.shippingCents, 0);
});

test("standard shipping: subtotal $50.01 (5001¢) IS free", () => {
  const r = computeShipping(5001, "ship", "standard", false);
  assert.equal(r.shippingCents, 0);
});

// ── each paid tier ────────────────────────────────────────────────────────────

test("pickup: always free regardless of subtotal", () => {
  const lo = computeShipping(100, "pickup", "standard", false);
  const hi = computeShipping(10000, "pickup", "standard", false);
  assert.equal(lo.shippingCents, 0);
  assert.equal(hi.shippingCents, 0);
});

test("ship / standard / below threshold = $9.99", () => {
  const r = computeShipping(2200, "ship", "standard", false);
  assert.equal(r.shippingCents, 999);
});

test("ship / priority / below threshold = $19.99", () => {
  const r = computeShipping(2200, "ship", "priority", false);
  assert.equal(r.shippingCents, 1999);
});

test("ship / overnight / below threshold = $24.99", () => {
  const r = computeShipping(2200, "ship", "overnight", false);
  assert.equal(r.shippingCents, 2499);
});

// ── expedite always paid — even above $50 threshold ──────────────────────────

test("expedite always paid: priority is $19.99 even at $50+ subtotal", () => {
  const r = computeShipping(5000, "ship", "priority", false);
  assert.equal(r.shippingCents, SHIP_PRIORITY_CENTS, "priority shipping is never free");
});

test("expedite always paid: overnight is $24.99 even at $50+ subtotal", () => {
  const r = computeShipping(5000, "ship", "overnight", false);
  assert.equal(r.shippingCents, SHIP_OVERNIGHT_CENTS, "overnight shipping is never free");
});

test("expedite always paid: priority $19.99 at $100 subtotal", () => {
  const r = computeShipping(10000, "ship", "priority", false);
  assert.equal(r.shippingCents, SHIP_PRIORITY_CENTS);
});

// ── local delivery: eligible vs ineligible ────────────────────────────────────
// local_delivery pricing = standard-ship rule regardless of zone eligibility.
// localEligible governs whether to offer local delivery, not what it costs.

test("local_delivery: subtotal >= $50, localEligible = FREE", () => {
  const r = computeShipping(5000, "local_delivery", "standard", true);
  assert.equal(r.shippingCents, 0);
});

test("local_delivery: subtotal >= $50, NOT localEligible = FREE (standard-ship fallback)", () => {
  // Key fix: ineligible does NOT make it $9.99 — falls back to standard-ship free rule
  const r = computeShipping(5000, "local_delivery", "standard", false);
  assert.equal(r.shippingCents, 0, "ineligible local_delivery at $50+ should be FREE, same as ship/standard");
});

test("local_delivery: subtotal < $50, localEligible = paid ($9.99)", () => {
  const r = computeShipping(4999, "local_delivery", "standard", true);
  assert.equal(r.shippingCents, SHIP_STANDARD_CENTS);
});

test("local_delivery: subtotal < $50, NOT localEligible = paid ($9.99)", () => {
  const r = computeShipping(2200, "local_delivery", "standard", false);
  assert.equal(r.shippingCents, SHIP_STANDARD_CENTS);
});

test("local_delivery: $50+ ineligible → $0 (the explicit boundary case)", () => {
  // Requested explicit test: >= $50, ineligible local = $0
  const r = computeShipping(5000, "local_delivery", "standard", false);
  assert.equal(r.shippingCents, 0);
});

test("local_delivery: $49.99 ineligible → $9.99 (below threshold, either eligibility)", () => {
  const eligible = computeShipping(4999, "local_delivery", "standard", true);
  const ineligible = computeShipping(4999, "local_delivery", "standard", false);
  assert.equal(eligible.shippingCents, SHIP_STANDARD_CENTS);
  assert.equal(ineligible.shippingCents, SHIP_STANDARD_CENTS);
});

// ── oversize escalation ───────────────────────────────────────────────────────

test("oversize escalation: banner_standard triggers manual freight flag", () => {
  const r = computeShipping(10000, "ship", "standard", false, "banner_standard");
  assert.ok(r.oversizeEscalation, "banner_standard must set oversizeEscalation=true");
});

test("oversize escalation: vinyl_mesh_materials triggers manual freight flag", () => {
  const r = computeShipping(10000, "ship", "standard", false, "vinyl_mesh_materials");
  assert.ok(r.oversizeEscalation);
});

test("oversize escalation: shippingCents is 0 when oversize (no auto-charge)", () => {
  const r = computeShipping(10000, "ship", "standard", false, "banner_standard");
  assert.equal(r.shippingCents, 0, "oversize orders must not auto-charge shipping");
});

test("oversize escalation: tshirt does NOT trigger oversize flag", () => {
  const r = computeShipping(2200, "ship", "standard", false, "tshirt");
  assert.ok(!r.oversizeEscalation);
  assert.equal(r.shippingCents, SHIP_STANDARD_CENTS);
});

test("oversize escalation: applies regardless of pickup method", () => {
  const r = computeShipping(5000, "pickup", "standard", false, "banner_standard");
  assert.ok(r.oversizeEscalation, "oversize flag fires on pickup too (oversized banner can't ship any method)");
});

// ── ready-to-ship ETA math ────────────────────────────────────────────────────

test("computeEtaDays: standard transit (7 days) + ready in 3 days = 10 days total", () => {
  const today = "2026-06-18";
  const ready = "2026-06-21"; // 3 days from today
  const eta = computeEtaDays("standard", ready, today);
  assert.equal(eta, 10); // 3 days until ready + 7 transit
});

test("computeEtaDays: priority transit (3 days) + ready in 5 days = 8 days total", () => {
  const today = "2026-06-18";
  const ready = "2026-06-23"; // 5 days from today
  const eta = computeEtaDays("priority", ready, today);
  assert.equal(eta, 8); // 5 + 3
});

test("computeEtaDays: overnight transit (1 day) + ready today = 1 day", () => {
  const today = "2026-06-18";
  const eta = computeEtaDays("overnight", today, today);
  assert.equal(eta, 1); // 0 days until ready + 1 transit
});

test("computeEtaDays: ready_to_ship_date in the past → still adds transit on top of 0", () => {
  const today = "2026-06-18";
  const ready = "2026-06-10"; // 8 days in the past
  const eta = computeEtaDays("standard", ready, today);
  assert.equal(eta, 7); // max(0, ...) = 0 + 7 transit
});

test("computeShipping: etaDays is null for pickup (no shipping transit)", () => {
  const r = computeShipping(5000, "pickup", "standard", false, undefined, "2026-06-25");
  assert.equal(r.etaDays, null);
});

test("computeShipping: etaDays is null for local_delivery", () => {
  const r = computeShipping(5000, "local_delivery", "standard", true, undefined, "2026-06-25");
  assert.equal(r.etaDays, null);
});

test("computeShipping: etaDays is null when no readyToShipDate provided", () => {
  const r = computeShipping(5000, "ship", "standard", false);
  assert.equal(r.etaDays, null);
});

test("computeShipping: etaDays is set for ship method with readyToShipDate", () => {
  // Use a deterministic date by injecting readyToShipDate (computeShipping calls computeEtaDays with today=now)
  const r = computeShipping(5000, "ship", "priority", false, "tshirt", "2026-06-30");
  assert.ok(r.etaDays !== null, "etaDays must be set for ship + readyToShipDate");
  assert.ok(r.etaDays! >= 3, "must be at least transit days (3) for priority");
});

// ── digital orders get no shipping (caller guard, module invariant) ───────────

test("OVERSIZE_PRODUCTS does not include 'digital' (digital orders skip this module)", () => {
  assert.ok(!OVERSIZE_PRODUCTS.has("digital"));
});

test("computeShipping with digital product_type: treated as standard shippable (module has no digital guard)", () => {
  // Digital orders should NOT reach computeShipping at all — the caller guards.
  // But if they somehow do, the module treats them like a normal shippable item.
  // This documents the expected behavior: no special $0 override inside the module.
  const r = computeShipping(500, "ship", "standard", false, "digital");
  assert.ok(!r.oversizeEscalation, "digital is not oversize");
  assert.equal(r.shippingCents, SHIP_STANDARD_CENTS); // 500¢ < threshold
});

// ── SHOP_ZIP default and isLocalEligible ─────────────────────────────────────

test("SHOP_ZIP defaults to 78577 (Pharr, TX)", () => {
  assert.equal(SHOP_ZIP, "78577");
});

test("isLocalEligible: Pharr (78577) is eligible (shop home ZIP)", () => {
  assert.ok(isLocalEligible("78577"));
});

test("isLocalEligible: McAllen core ZIPs are eligible", () => {
  for (const z of ["78501", "78502", "78503", "78504", "78505"]) {
    assert.ok(isLocalEligible(z), `${z} (McAllen) should be in the local zone`);
  }
});

test("isLocalEligible: Edinburg ZIPs are eligible", () => {
  for (const z of ["78539", "78541", "78542"]) {
    assert.ok(isLocalEligible(z), `${z} (Edinburg) should be in the local zone`);
  }
});

test("isLocalEligible: Mission ZIPs are eligible", () => {
  for (const z of ["78572", "78573", "78574"]) {
    assert.ok(isLocalEligible(z), `${z} (Mission) should be in the local zone`);
  }
});

test("isLocalEligible: other RGV core cities are eligible", () => {
  const cases: [string, string][] = [
    ["78516", "Alamo"],
    ["78537", "Donna"],
    ["78557", "Hidalgo"],
    ["78570", "Mercedes"],
    ["78589", "San Juan"],
    ["78596", "Weslaco"],
  ];
  for (const [z, city] of cases) {
    assert.ok(isLocalEligible(z), `${z} (${city}) should be in the local zone`);
  }
});

test("isLocalEligible: ZIP outside RGV is not eligible", () => {
  assert.ok(!isLocalEligible("78701")); // Austin
  assert.ok(!isLocalEligible("90210")); // Beverly Hills
  assert.ok(!isLocalEligible("10001")); // New York
});

test("isLocalEligible: Laredo ZIP is not eligible (~150mi away)", () => {
  assert.ok(!isLocalEligible("78040")); // Laredo
});

// ── run ───────────────────────────────────────────────────────────────────────

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
