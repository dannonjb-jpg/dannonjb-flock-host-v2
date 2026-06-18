# Increment 4 — Element-Addressable Mockup Spec

**Branch:** `element-addressable-spec` (off `fulfillment`)
**Commit:** `99439e8`
**Date:** 2026-06-18
**Payments path:** untouched (zero diff in `src/payments/`)
**Not merged.**

---

## Part F — Report

### 1. ElementSpec + JobSpec types — where added

| Location | Change |
|---|---|
| `src/domain/types.ts:34–54` | `ElementSpec` interface added |
| `src/domain/types.ts:96–99` | `Order.elements?: ElementSpec[]` added (in-memory; persisted via job_spec) |
| `src/domain/types.ts:141–157` | `JobSpec` replaced with fully typed version including `elements`, `last_brief`, all runtime fields |

**ElementSpec fields:**
```typescript
export interface ElementSpec {
  element_id: string;           // "logo_main" | "text_headline" | "product_main" | ...
  type: "image" | "text" | "shape";
  locked: boolean;              // always true for all elements (content lock)
  content?: string;             // reference only — NEVER read by compositor
  asset_id?: string;            // reference only — NEVER read by compositor
  position?: { x: number; y: number };      // fraction 0..1
  size?: { width: number; height: number }; // fraction 0..1
  font?: { family: string; weight: number; size_points: number };
  color?: string;               // #hex — overrides palette for text
  opacity?: number;             // 0..1
}
```

**Content lock:** `content` and `asset_id` exist in the schema as reference fields only. The compositor never reads them for rendering. Assets always come from `AssetStore`; text always comes from the `Order` row. This is enforced in both `placeRegion()` and `renderTextSvg()`.

---

### 2. mergeElementSpec — location + signature

**`src/integrations/sharp-compositor.ts:315–340`**

```typescript
export function mergeElementSpec(base: ElementSpec, override: ElementSpec): ElementSpec
```

Merge rules:
- `element_id`, `type`, `locked` — always from `base`
- `content`, `asset_id` — always from `base` (content lock; override values silently ignored)
- `position`, `size`, `color`, `opacity` — `override` wins if present; `base` value is fallback
- `font` — field-level merge: `{ ...base.font, ...override.font }` (override fields win per-key)

---

### 3. placeRegion / render update locations

| Function | File:line | Change |
|---|---|---|
| `composite()` | `sharp-compositor.ts:420–470` | Loops now call `mergeElementSpec(templateEl, override)` per region/text before rendering |
| `placeRegion()` | `sharp-compositor.ts:510–550` | New `merged: ElementSpec` param; uses `merged.position/size` for box coordinates; NEVER `merged.asset_id` |
| `renderTextSvg()` | `sharp-compositor.ts:560–605` | New `merged: ElementSpec` param; uses `merged.position/size/font/color` for styling; text content ALWAYS from `order.client_name/business_name` |

**Element ID helpers (new, exported):**
- `regionElementId(r)` → `${r.role}_main` (e.g. `logo_main`, `product_main`, `qr_main`)
- `textElementId(t, idx)` → `text_headline` for idx=0, `text_N` for others

**Element builder (new, exported):**
- `buildInitialElements(tpl: Template): ElementSpec[]` — extracts template defaults
- `buildInitialElementsForProductType(productType: string): ElementSpec[]` — looks up REGISTRY, builds from template A

---

### 4. Migration logic location

**`src/brain/action-applier.ts`:**

- `onRequestMockup()` (`:310–330`): after getting URLs, checks `if (!spec.elements || spec.elements.length === 0)` and calls `buildInitialElementsForProductType(productType)`. Elements stored in `patchOrder({ job_spec: ... })`.
- `onDigitalComplete()` (`:550–570`): same migration guard.
- `ensureElementsInitialized(spec, productType)` (`:30–35`, exported): the shared "migrate if absent" helper; returns existing elements or builds from template.

---

### 5. onRevisionNote update

**`src/brain/action-applier.ts:500–540`** (digital track)

New flow:
1. Check available rounds (unchanged)
2. Increment `digital_rounds_used` (first `patchOrder`)
3. `ensureElementsInitialized()` — legacy migration if elements absent
4. `parseRevisionDirectives(note, baseElements)` — parse note for directives
5. `applyElementDirectives(baseElements, directives)` — apply to element array
6. `spec.last_brief = note`
7. `patchOrder({ job_spec: spec })` before `generate()` — compositor reads updated layout
8. `generate(withElements, "both", note)` — renders with new element overrides
9. `patchOrder` with `mockup_urls`

**Exported helpers (for testability):**
- `parseRevisionDirectives(note, elements): ElementSpec[]` — MVP heuristic; returns complete updated objects
- `applyElementDirectives(current, updates): ElementSpec[]` — replaces by `element_id`

**Directive patterns recognized (MVP):**
| Pattern | Effect |
|---|---|
| `"make/scale ... logo/image ... bigger/larger"` | `logo_main` scaled up 1.2x (capped at 1.0) |
| `"make/scale ... logo/image ... smaller/tinier"` | `logo_main` scaled down 0.8x (floor 0.05) |
| `"make/scale ... text ... bigger/larger"` | `text_headline` fontFrac scaled up 1.2x |
| `"change color to <name\|#hex>"` | `text_headline.color` set to resolved hex |

**TODO:** replace heuristic with LLM-powered parsing (e.g. a structured `collect`-style output from the brain).

---

### 6. Test results

```
31/31 passed  (test/element-addressable.test.ts — NEW)
 6/6  passed  (test/compositor-smoke.test.ts — unchanged, regression check)
63/63 passed  (test/pricing.test.ts — unchanged)
46/46 passed  (test/shipping.test.ts — unchanged)
```

**New test coverage:**
- `mergeElementSpec` — 7 tests (override wins, content lock, font merge, no-override)
- `buildInitialElements` / `buildInitialElementsForProductType` — 6 tests
- `regionElementId` / `textElementId` — 1 test
- Render determinism: same inputs → byte-identical PNG — 1 test
- Render with size override: different elements → different PNG — 1 test
- Content lock (logo): `resolveLogo` always called regardless of `element.asset_id` — 1 test
- Content lock (text): render differs with vs without `order.business_name`; `element.content` ignored — 1 test
- `ensureElementsInitialized` — 3 tests
- `parseRevisionDirectives` — 5 tests ("make logo bigger", smaller, color named, color hex, unrecognized)
- `applyElementDirectives` — 3 tests
- Legacy migration pipeline end-to-end — 1 test

---

### 7. Diff summary

| File | Lines +/- | Notes |
|---|---|---|
| `src/domain/types.ts` | +46 / -6 | `ElementSpec` interface; `Order.elements`; `JobSpec` fully typed |
| `src/integrations/sharp-compositor.ts` | +120 / -12 | 5 new exports; `composite`, `placeRegion`, `renderTextSvg` updated |
| `src/brain/action-applier.ts` | +120 / -8 | 3 exported helpers; `onRequestMockup`, `onDigitalComplete`, `onRevisionNote` updated |
| `test/element-addressable.test.ts` | +310 / 0 | **NEW** — 31 tests |
| `package.json` | +1 / 0 | `test:element-addressable` script |

**Total: ~600 insertions, ~26 deletions across 5 files**

---

### 8. TODO flags / MVP heuristics

- **`parseRevisionDirectives`** is explicitly flagged `// TODO: replace with LLM-powered directive parsing` in `action-applier.ts`. Recognized patterns are minimal (4 heuristics). In production this should be replaced with a structured brain output (e.g. the brain emits a `revision_directive` action with structured fields instead of free text).
- **`78562` (La Villa) and `78593` (Valley View)** in the ZIP allowlist are flagged `⚠ borderline — verify` (from Increment 3). These are not related to this increment but remain open.
- **`Order.elements`** is typed on the interface but has no DB column in this increment. Elements are persisted as part of `job_spec` JSON. If elements need to be queryable independently, a future migration should add a column and update PATCHABLE in `sqlite-store.ts`.
- **Template A used for element initialization.** `buildInitialElementsForProductType` always uses the `A` template as the canonical element layout. Template B has different region positions; a revision applied to the A-initialized elements will affect both A and B renders (the compositor merges the same elements into both). Full per-variant element overrides would require a `variant` field on `ElementSpec`.
