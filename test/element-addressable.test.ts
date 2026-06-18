// test/element-addressable.test.ts
// Tests for the element-addressable-spec increment:
//   - mergeElementSpec (unit)
//   - buildInitialElements / buildInitialElementsForProductType (unit)
//   - SharpCompositor render with element overrides (integration)
//   - Content lock: logo always from AssetStore, text always from Order row (integration)
//   - ensureElementsInitialized + parseRevisionDirectives + applyElementDirectives (unit)

import assert from "node:assert/strict";
import sharp from "sharp";
import {
  mergeElementSpec,
  buildInitialElements,
  buildInitialElementsForProductType,
  regionElementId,
  textElementId,
  SharpCompositor,
  AssetGateError,
} from "../src/integrations/sharp-compositor.js";
import type { Template, MockupSink } from "../src/integrations/sharp-compositor.js";
import type { AssetStore, ResolvedAsset } from "../src/store/asset-store.js";
import type { ElementSpec, Order } from "../src/domain/types.js";
import {
  ensureElementsInitialized,
  parseRevisionDirectives,
  applyElementDirectives,
} from "../src/brain/action-applier.js";

// ── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(
    () => { console.log(`  ✓ ${name}`); passed++; },
    (e: unknown) => { console.log(`  ✗ ${name}: ${(e as Error).message}`); failed++; },
  );
}

// ── shared fixtures ───────────────────────────────────────────────────────────

const MINIMAL_TEMPLATE: Template = {
  id: "test.A",
  product_type: "test",
  canvasPx: { w: 1000, h: 500 },
  defaultPalette: { bg: "#ffffff", fg: "#000000", accent: "#ff0000" },
  regions: [
    { role: "logo", x: 0.05, y: 0.1, w: 0.2, h: 0.8 },
    { role: "product", x: 0.3, y: 0.1, w: 0.4, h: 0.8 },
  ],
  text: [
    { source: "business_name", x: 0.75, y: 0.2, fontFrac: 0.1, colorKey: "fg", weight: 700, anchor: "start" },
  ],
};

const BASE_ORDER: Order = {
  order_id: "ord-test",
  whatsapp_jid: "test@s.whatsapp.net",
  state: "mockup",
  track: "digital",
  client_name: "Alice",
  business_name: "Alice Corp",
  project_type: "business",
  selected_mockup: null,
  failed_mockup_pairs: 0,
  digital_rounds_used: 0,
  escalation: null,
  turn_count: 1,
  created_at: "2026-06-18T00:00:00Z",
  updated_at: "2026-06-18T00:00:00Z",
  job_spec: JSON.stringify({ specs: { product_type: "banner_standard", qr_content: "https://example.com" } }),
} as unknown as Order;

async function makePng(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 150, g: 100, b: 200, alpha: 1 } } })
    .png().toBuffer();
}

function makeAsset(content: Buffer, w: number, h: number, type: "logo" | "product" = "logo"): ResolvedAsset {
  return {
    asset_id: "asset-" + type,
    jid: BASE_ORDER.whatsapp_jid,
    bytes_hash: "x",
    asset_type: type,
    role: "fidelity",
    role_source: "client_stated",
    resolution_hint: "high_res",
    width_px: w, height_px: h, is_vector: false,
    version: 1, is_current: true, source_message: null,
    created_at: "2026-06-18T00:00:00Z",
    content, bytes_size: content.length,
  };
}

function makeStore(logo: ResolvedAsset | null, product?: ResolvedAsset | null): AssetStore {
  return {
    resolveLogo: () => logo,
    resolveAsset: (_jid: string, type: string) => type === "product" ? (product ?? null) : null,
  } as unknown as AssetStore;
}

function makeSink(): { sink: MockupSink; captured: Map<string, Buffer> } {
  const captured = new Map<string, Buffer>();
  return {
    sink: {
      async write(order: Order, variant: "A" | "B", png: Buffer) {
        captured.set(variant, png);
        return `https://example.com/${order.order_id}_${variant}.png`;
      },
    },
    captured,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PART 1 — mergeElementSpec (pure unit tests)
// ══════════════════════════════════════════════════════════════════════════════

await test("mergeElementSpec: override position wins over base", () => {
  const base: ElementSpec = {
    element_id: "logo_main", type: "image", locked: true,
    position: { x: 0.1, y: 0.1 }, size: { width: 0.2, height: 0.2 },
  };
  const override: ElementSpec = {
    element_id: "logo_main", type: "image", locked: true,
    position: { x: 0.5, y: 0.5 },
  };
  const merged = mergeElementSpec(base, override);
  assert.deepEqual(merged.position, { x: 0.5, y: 0.5 }, "override position used");
  assert.deepEqual(merged.size, base.size, "base size retained when override absent");
});

await test("mergeElementSpec: override size wins; missing fields fall back to base", () => {
  const base: ElementSpec = {
    element_id: "logo_main", type: "image", locked: true,
    position: { x: 0.04, y: 0.18 }, size: { width: 0.22, height: 0.64 },
  };
  const override: ElementSpec = {
    element_id: "logo_main", type: "image", locked: true,
    size: { width: 0.4, height: 0.4 },
  };
  const merged = mergeElementSpec(base, override);
  assert.deepEqual(merged.size, { width: 0.4, height: 0.4 }, "override size used");
  assert.deepEqual(merged.position, base.position, "base position retained");
});

await test("mergeElementSpec: color override wins; no color in base → undefined", () => {
  const base: ElementSpec = { element_id: "text_headline", type: "text", locked: true };
  const override: ElementSpec = { element_id: "text_headline", type: "text", locked: true, color: "#ff0000" };
  const merged = mergeElementSpec(base, override);
  assert.equal(merged.color, "#ff0000");
});

await test("mergeElementSpec: content fields (content, asset_id) ALWAYS from base — locked", () => {
  const base: ElementSpec = {
    element_id: "logo_main", type: "image", locked: true,
    asset_id: "real-asset-id", content: "real-content",
  };
  const override: ElementSpec = {
    element_id: "logo_main", type: "image", locked: true,
    asset_id: "injected-id", content: "injected-content",
    position: { x: 0.9, y: 0.9 },
  };
  const merged = mergeElementSpec(base, override);
  assert.equal(merged.asset_id, "real-asset-id", "asset_id from base (locked)");
  assert.equal(merged.content, "real-content", "content from base (locked)");
  assert.deepEqual(merged.position, { x: 0.9, y: 0.9 }, "position still overridden");
});

await test("mergeElementSpec: partial font override (weight only) merges with base font", () => {
  const base: ElementSpec = {
    element_id: "text_headline", type: "text", locked: true,
    font: { family: "DejaVu Sans", weight: 400, size_points: 0 },
  };
  const override: ElementSpec = {
    element_id: "text_headline", type: "text", locked: true,
    font: { family: "DejaVu Sans", weight: 700, size_points: 0 },
  };
  const merged = mergeElementSpec(base, override);
  assert.equal(merged.font?.weight, 700, "override weight wins");
  assert.equal(merged.font?.family, "DejaVu Sans", "base family retained");
});

await test("mergeElementSpec: no override → merged is copy of base", () => {
  const base: ElementSpec = {
    element_id: "qr_main", type: "image", locked: true,
    position: { x: 0.78, y: 0.22 }, size: { width: 0.18, height: 0.56 },
  };
  // Override with same element_id but no overridable fields
  const override: ElementSpec = { element_id: "qr_main", type: "image", locked: true };
  const merged = mergeElementSpec(base, override);
  assert.deepEqual(merged.position, base.position);
  assert.deepEqual(merged.size, base.size);
});

await test("mergeElementSpec: opacity override wins", () => {
  const base: ElementSpec = { element_id: "logo_main", type: "image", locked: true, opacity: 1.0 };
  const override: ElementSpec = { element_id: "logo_main", type: "image", locked: true, opacity: 0.5 };
  assert.equal(mergeElementSpec(base, override).opacity, 0.5);
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 2 — buildInitialElements (unit)
// ══════════════════════════════════════════════════════════════════════════════

await test("buildInitialElements: correct element_ids from template", () => {
  const elements = buildInitialElements(MINIMAL_TEMPLATE);
  const ids = elements.map(e => e.element_id);
  assert.ok(ids.includes("logo_main"), "logo_main present");
  assert.ok(ids.includes("product_main"), "product_main present");
  assert.ok(ids.includes("text_headline"), "text_headline present");
});

await test("buildInitialElements: all elements have locked=true", () => {
  const elements = buildInitialElements(MINIMAL_TEMPLATE);
  assert.ok(elements.every(e => e.locked === true), "all locked");
});

await test("buildInitialElements: image element position/size matches template region", () => {
  const elements = buildInitialElements(MINIMAL_TEMPLATE);
  const logo = elements.find(e => e.element_id === "logo_main")!;
  assert.ok(logo, "logo element exists");
  assert.deepEqual(logo.position, { x: 0.05, y: 0.1 });
  assert.deepEqual(logo.size, { width: 0.2, height: 0.8 });
});

await test("buildInitialElements: text element position matches template TextSpec", () => {
  const elements = buildInitialElements(MINIMAL_TEMPLATE);
  const text = elements.find(e => e.element_id === "text_headline")!;
  assert.ok(text, "text_headline element exists");
  assert.deepEqual(text.position, { x: 0.75, y: 0.2 });
});

await test("buildInitialElementsForProductType: banner_standard returns known element_ids", () => {
  const elements = buildInitialElementsForProductType("banner_standard");
  const ids = new Set(elements.map(e => e.element_id));
  assert.ok(ids.has("logo_main"));
  assert.ok(ids.has("product_main"));
  assert.ok(ids.has("qr_main"));
  assert.ok(ids.has("text_headline"));
});

await test("buildInitialElementsForProductType: unknown type falls to generic template", () => {
  const elements = buildInitialElementsForProductType("mystery_product");
  assert.ok(elements.length > 0, "generic fallback produces elements");
});

await test("regionElementId: produces role_main pattern", () => {
  assert.equal(regionElementId({ role: "logo" }), "logo_main");
  assert.equal(regionElementId({ role: "qr" }), "qr_main");
  assert.equal(regionElementId({ role: "product" }), "product_main");
});

await test("textElementId: index 0 → text_headline, others → text_N", () => {
  assert.equal(textElementId({ source: "business_name" }, 0), "text_headline");
  assert.equal(textElementId({ source: "client_name" }, 1), "text_1");
  assert.equal(textElementId({ source: "custom" }, 2), "text_2");
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 3 — Render with element overrides (integration via SharpCompositor)
// ══════════════════════════════════════════════════════════════════════════════

await test("render determinism: same ElementSpec inputs produce identical PNG bytes", async () => {
  const logoPng = await makePng(2000, 2000);
  const productPng = await makePng(2000, 1500);
  const { sink: sink1, captured: cap1 } = makeSink();
  const { sink: sink2, captured: cap2 } = makeSink();
  const store = makeStore(makeAsset(logoPng, 2000, 2000), makeAsset(productPng, 2000, 1500, "product"));

  const order: Order = {
    ...BASE_ORDER,
    job_spec: JSON.stringify({
      specs: { product_type: "banner_standard", qr_content: "https://example.com" },
      elements: buildInitialElementsForProductType("banner_standard"),
    }),
  } as unknown as Order;

  await new SharpCompositor({ assets: store, sink: sink1 }).generate(order, "A", "brief");
  await new SharpCompositor({ assets: store, sink: sink2 }).generate(order, "A", "brief");

  const buf1 = cap1.get("A")!;
  const buf2 = cap2.get("A")!;
  assert.ok(buf1, "first render produced output");
  assert.ok(buf2, "second render produced output");
  assert.equal(buf1.compare(buf2), 0, "byte-identical output for identical inputs");
});

await test("render with size override: logo sized differently produces different PNG", async () => {
  const logoPng = await makePng(2000, 2000);
  const productPng = await makePng(2000, 1500);
  const store = makeStore(makeAsset(logoPng, 2000, 2000), makeAsset(productPng, 2000, 1500, "product"));

  const defaultElements = buildInitialElementsForProductType("banner_standard");
  const biggerElements = defaultElements.map(e =>
    e.element_id === "logo_main" && e.size
      ? { ...e, size: { width: e.size.width * 1.4, height: e.size.height * 1.4 } }
      : e,
  );

  const orderDefault: Order = { ...BASE_ORDER, job_spec: JSON.stringify({ specs: { product_type: "banner_standard" }, elements: defaultElements }) } as unknown as Order;
  const orderBigger: Order = { ...BASE_ORDER, job_spec: JSON.stringify({ specs: { product_type: "banner_standard" }, elements: biggerElements }) } as unknown as Order;

  const { sink: s1, captured: c1 } = makeSink();
  const { sink: s2, captured: c2 } = makeSink();
  await new SharpCompositor({ assets: store, sink: s1 }).generate(orderDefault, "A", "");
  await new SharpCompositor({ assets: store, sink: s2 }).generate(orderBigger, "A", "");

  assert.notEqual(c1.get("A")!.compare(c2.get("A")!), 0, "different sizes → different PNG");
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 4 — Content lock (integration)
// ══════════════════════════════════════════════════════════════════════════════

await test("content lock: logo ALWAYS fetched from AssetStore (resolveLogo called)", async () => {
  const logoPng = await makePng(2000, 2000);
  const productPng = await makePng(2000, 1500);
  let resolveLogoCalled = false;
  let resolveLogoJid = "";

  const trackingStore: AssetStore = {
    resolveLogo: (jid: string) => {
      resolveLogoCalled = true;
      resolveLogoJid = jid;
      return makeAsset(logoPng, 2000, 2000);
    },
    resolveAsset: (_jid: string, type: string) =>
      type === "product" ? makeAsset(productPng, 2000, 1500, "product") : null,
  } as unknown as AssetStore;

  // Inject an asset_id in the element — compositor must NOT use this
  const elements = buildInitialElementsForProductType("banner_standard").map(e =>
    e.element_id === "logo_main" ? { ...e, asset_id: "injected-asset-id-should-be-ignored" } : e,
  );
  const order: Order = {
    ...BASE_ORDER,
    job_spec: JSON.stringify({ specs: { product_type: "banner_standard" }, elements }),
  } as unknown as Order;

  const { sink } = makeSink();
  await new SharpCompositor({ assets: trackingStore, sink }).generate(order, "A", "");
  assert.ok(resolveLogoCalled, "resolveLogo was called (not a direct asset lookup)");
  assert.equal(resolveLogoJid, BASE_ORDER.whatsapp_jid, "resolveLogo called with correct JID");
});

await test("content lock: text ALWAYS from Order row, element.content field never used", async () => {
  const logoPng = await makePng(2000, 2000);
  const productPng = await makePng(2000, 1500);
  const store = makeStore(makeAsset(logoPng, 2000, 2000), makeAsset(productPng, 2000, 1500, "product"));

  // business_name = "CorrectBiz"; elements text has content = "WrongBiz" (should be ignored)
  const elements = buildInitialElementsForProductType("banner_standard").map(e =>
    e.element_id === "text_headline" ? { ...e, content: "WrongBiz — must never appear" } : e,
  );
  const orderCorrect: Order = {
    ...BASE_ORDER,
    business_name: "CorrectBiz",
    job_spec: JSON.stringify({ specs: { product_type: "banner_standard" }, elements }),
  } as unknown as Order;
  const orderNoName: Order = {
    ...BASE_ORDER,
    business_name: null, // no name → text region silently absent
    job_spec: JSON.stringify({ specs: { product_type: "banner_standard" }, elements }),
  } as unknown as Order;

  const { sink: s1, captured: c1 } = makeSink();
  const { sink: s2, captured: c2 } = makeSink();

  // Both should render without error. The one with no name produces a PNG without
  // the text layer (text silently absent is correct behavior per design invariant).
  await new SharpCompositor({ assets: store, sink: s1 }).generate(orderCorrect, "A", "");
  await new SharpCompositor({ assets: store, sink: s2 }).generate(orderNoName, "A", "");

  const metaA = await sharp(c1.get("A")!).metadata();
  const metaB = await sharp(c2.get("A")!).metadata();
  // Both are valid PNGs (no crash on content field being present in elements)
  assert.equal(metaA.format, "png");
  assert.equal(metaB.format, "png");
  // Renders differ (with-name vs no-name) — proves text comes from Order, not element.content
  assert.notEqual(c1.get("A")!.compare(c2.get("A")!), 0, "with vs without name → different output");
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 5 — Revision directive helpers (unit)
// ══════════════════════════════════════════════════════════════════════════════

await test("ensureElementsInitialized: returns existing elements if already populated", () => {
  const existing: ElementSpec[] = [{ element_id: "logo_main", type: "image", locked: true }];
  const result = ensureElementsInitialized({ elements: existing }, "banner_standard");
  assert.equal(result, existing, "same array reference returned");
});

await test("ensureElementsInitialized: builds from template when elements absent", () => {
  const result = ensureElementsInitialized({}, "banner_standard");
  assert.ok(result.length > 0, "elements populated from template");
  assert.ok(result.some(e => e.element_id === "logo_main"));
});

await test("ensureElementsInitialized: builds from template when elements is empty array", () => {
  const result = ensureElementsInitialized({ elements: [] }, "generic");
  assert.ok(result.length > 0, "empty array triggers re-initialization");
});

await test("parseRevisionDirectives: 'make logo bigger' scales logo_main up by 1.2x", () => {
  const elements = buildInitialElementsForProductType("banner_standard");
  const logo = elements.find(e => e.element_id === "logo_main")!;
  const updates = parseRevisionDirectives("make the logo bigger", elements);
  const updated = updates.find(e => e.element_id === "logo_main");
  assert.ok(updated, "logo_main update produced");
  assert.ok(updated.size!.width > logo.size!.width, "width increased");
  assert.ok(updated.size!.height > logo.size!.height, "height increased");
  // Should be approximately 1.2x
  assert.ok(
    Math.abs(updated.size!.width / logo.size!.width - 1.2) < 0.001,
    "width is 1.2x of original",
  );
});

await test("parseRevisionDirectives: 'make logo smaller' scales logo_main down by 0.8x", () => {
  const elements = buildInitialElementsForProductType("banner_standard");
  const logo = elements.find(e => e.element_id === "logo_main")!;
  const updates = parseRevisionDirectives("please make the logo smaller", elements);
  const updated = updates.find(e => e.element_id === "logo_main");
  assert.ok(updated, "logo_main update produced");
  assert.ok(updated.size!.width < logo.size!.width, "width decreased");
});

await test("parseRevisionDirectives: 'change color to red' sets text_headline color", () => {
  const elements = buildInitialElementsForProductType("banner_standard");
  const updates = parseRevisionDirectives("change color to red", elements);
  const updated = updates.find(e => e.element_id === "text_headline");
  assert.ok(updated, "text_headline update produced");
  assert.equal(updated.color, "#ff0000");
});

await test("parseRevisionDirectives: 'change color to #3344ff' sets hex directly", () => {
  const elements = buildInitialElementsForProductType("banner_standard");
  const updates = parseRevisionDirectives("change color to #3344ff please", elements);
  const updated = updates.find(e => e.element_id === "text_headline");
  assert.ok(updated, "text_headline update produced");
  assert.equal(updated.color, "#3344ff");
});

await test("parseRevisionDirectives: unrecognized note returns empty array (no change)", () => {
  const elements = buildInitialElementsForProductType("banner_standard");
  const updates = parseRevisionDirectives("I love this design!", elements);
  assert.equal(updates.length, 0, "no directives for unrecognized note");
});

await test("applyElementDirectives: update replaces matching element", () => {
  const current: ElementSpec[] = [
    { element_id: "logo_main", type: "image", locked: true, size: { width: 0.2, height: 0.6 } },
    { element_id: "text_headline", type: "text", locked: true },
  ];
  const updates: ElementSpec[] = [
    { element_id: "logo_main", type: "image", locked: true, size: { width: 0.3, height: 0.7 } },
  ];
  const result = applyElementDirectives(current, updates);
  const logo = result.find(e => e.element_id === "logo_main")!;
  assert.deepEqual(logo.size, { width: 0.3, height: 0.7 }, "logo updated");
  assert.equal(result.length, 2, "text_headline preserved");
});

await test("applyElementDirectives: unchanged elements are preserved", () => {
  const current: ElementSpec[] = [
    { element_id: "logo_main", type: "image", locked: true },
    { element_id: "text_headline", type: "text", locked: true, color: "#123456" },
  ];
  const updates: ElementSpec[] = [
    { element_id: "logo_main", type: "image", locked: true, size: { width: 0.5, height: 0.5 } },
  ];
  const result = applyElementDirectives(current, updates);
  const text = result.find(e => e.element_id === "text_headline")!;
  assert.equal(text.color, "#123456", "text_headline color unchanged");
});

await test("applyElementDirectives: empty updates returns current unchanged", () => {
  const current: ElementSpec[] = [{ element_id: "logo_main", type: "image", locked: true }];
  const result = applyElementDirectives(current, []);
  assert.equal(result, current, "same reference returned");
});

await test("legacy migration: parseRevisionDirectives → applyElementDirectives pipeline", () => {
  // Simulates first revision on an order with no elements (legacy order).
  const spec = {
    specs: { product_type: "banner_standard" },
    // no elements
  };
  const productType = spec.specs.product_type;
  const baseElements = ensureElementsInitialized(spec, productType);
  assert.ok(baseElements.length > 0, "elements initialized from template");

  const directives = parseRevisionDirectives("make the logo bigger", baseElements);
  const updated = applyElementDirectives(baseElements, directives);

  const logo = updated.find(e => e.element_id === "logo_main")!;
  const originalLogo = baseElements.find(e => e.element_id === "logo_main")!;
  assert.ok(logo.size!.width > originalLogo.size!.width, "logo scaled up after migration + directive");
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
