// src/integrations/sharp-compositor.ts
//
// Sharp compositor for the Flock mockup pipeline.
// Implements MockupPipeline.generate by compositing RESOLVED assets onto a
// base image produced by an injected ArtGenerator.
//
// ─── DESIGN INVARIANTS (do not break without escalating) ──────────────────────
//
//  1. STRUCTURED IN, NEVER PROSE. The compositor consumes structured layout
//     directives: a per-product_type template (regions + canvas) plus explicit
//     structured fields (colours as hex, qr_content, text). `specs.description`
//     and `last_brief` are the BRAIN's input, not ours. If a structured field is
//     missing, fall back to the template default — NEVER regex the description.
//     Parsing prose here would reintroduce the exact non-determinism the Sharp
//     pivot exists to remove, and it is untestable.
//
//  2. PLUGGABLE BASE via ArtGenerator. Phase1Base returns a deterministic solid
//     background. GptImage1Generator calls gpt-image-1 with a 120s AbortController
//     timeout and returns the raw art buffer. composite() is agnostic to which is
//     active. Swap by injecting a different ArtGenerator — no other changes needed.
//
//  3. FIDELITY IS GATED. Assets are checked with coarseUsable. The AUTHORITATIVE
//     gate lives in action-applier (BEFORE the state transition, per the locked
//     design); the check here is defence-in-depth. On failure it THROWS
//     AssetGateError rather than silently degrading — action-applier should catch
//     it, leave the order re-requestable, and have the brain ask the client for a
//     higher-resolution or vector asset.
//
//  4. NO SILENT FAILURE. Logo and product assets throw typed errors on miss or
//     below-floor resolution. QR is the exception: absent qr_content skips the
//     region (client may not provide a link) — the mockup renders without it.
//     A placeholder is never emitted where a logo or product should be.

import sharp from "sharp";
import QRCode from "qrcode";

import {
  AssetStore,
  ResolvedAsset,
  AssetMeta,
  AssetType,
  coarseUsable,
} from "../store/asset-store";

import type { Order, ElementSpec } from "../domain/types";
import type { MockupUrls } from "../domain/integrations";

// ─── Pipeline + sink contracts ────────────────────────────────────────────────
// MockupPipeline is the interface action-applier injects (ApplyDeps). If it is
// already declared in the host, delete this copy and import it instead.

export type Variant = "A" | "B" | "both";

export interface MockupPipeline {
  generate(order: Order, variant: Variant, brief: string): Promise<MockupUrls>;
}

// ─── ArtGenerator — the generateArt / composite split ─────────────────────────
// generateArt produces the base image buffer from structured fields.
// composite() (in SharpCompositor) places logo, text, QR on top.
// Swap Phase1Base for GptImage1Generator in index.ts — nothing else changes.

export interface ArtGenerator {
  /** Returns a raw PNG buffer sized to tpl.canvasPx. */
  generateArt(spec: JobSpec, tpl: Template, palette: Palette, brief: string): Promise<Buffer>;
}

// Phase 1: deterministic solid-colour background — zero API spend.
export class Phase1Base implements ArtGenerator {
  async generateArt(_spec: JobSpec, tpl: Template, palette: Palette, _brief: string): Promise<Buffer> {
    return sharp({
      create: {
        width: tpl.canvasPx.w,
        height: tpl.canvasPx.h,
        channels: 4,
        background: palette.bg,
      },
    })
      .png()
      .toBuffer();
  }
}

// Phase 2: gpt-image-1 base. Requires OPENAI_API_KEY in env.
// Spend is logged per call so it surfaces in journalctl.
export class GptImage1Generator implements ArtGenerator {
  constructor(private readonly apiKey: string) {}

  async generateArt(spec: JobSpec, tpl: Template, _palette: Palette, brief: string): Promise<Buffer> {
    const prompt = this.buildPrompt(spec, tpl, brief);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);

    const body = JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: `${tpl.canvasPx.w}x${tpl.canvasPx.h}` as string,
      quality: "low",
      n: 1,
      response_format: "b64_json",
    });

    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`gpt-image-1 ${res.status}: ${err}`);
    }

    const json = await res.json() as { data: Array<{ b64_json: string }> };
    const b64 = json.data[0]?.b64_json;
    if (!b64) throw new Error("gpt-image-1 returned no image data");

    // Spend log: gpt-image-1 low quality 1024×1024 ≈ $0.011/image (adjust if pricing changes).
    const product_type = spec.specs?.product_type ?? "unknown";
    console.log(`[spend:gpt-image-1] product=${product_type} size=${tpl.canvasPx.w}x${tpl.canvasPx.h} quality=low ~$0.011`);

    return Buffer.from(b64, "base64");
  }

  private buildPrompt(spec: JobSpec, tpl: Template, brief: string): string {
    const parts: string[] = [];
    if (brief) parts.push(brief);
    if (spec.theme) parts.push(`theme: ${spec.theme}`);
    if (spec.style) parts.push(`style: ${spec.style}`);
    if (spec.color_palette?.length) parts.push(`colors: ${spec.color_palette.join(", ")}`);
    parts.push(`product: ${spec.specs?.product_type ?? tpl.product_type}`);
    parts.push("professional marketing mockup, no text overlay, clean background");
    return parts.join(". ");
  }
}

// The compositor does not know where artefacts are served from. The sink owns
// the output location and the public URL (e.g. /var/www/mockups + nginx base).
export interface MockupSink {
  write(order: Order, variant: "A" | "B", png: Buffer): Promise<string>; // -> public URL
}

// ─── Local overlay type (only the fields sharp.composite() actually uses here) ─
// Avoids a hard dependency on sharp's internal OverlayOptions type, which is
// unreachable via moduleResolution=Bundler due to sharp's exports map lacking
// a "types" condition.
interface OverlayOptions {
  input: Buffer | string;
  left?: number;
  top?: number;
}

// ─── Typed failures (no silent degradation) ───────────────────────────────────

export class AssetGateError extends Error {
  constructor(
    public readonly role: AssetType,
    public readonly meta: Pick<AssetMeta, "width_px" | "height_px" | "is_vector">,
  ) {
    super(
      `asset '${role}' is below the print floor ` +
        `(${meta.width_px}x${meta.height_px}px, vector=${meta.is_vector})`,
    );
    this.name = "AssetGateError";
  }
}

export class MissingAssetError extends Error {
  constructor(public readonly role: AssetType, jid: string) {
    super(`required asset '${role}' not found for jid ${jid}`);
    this.name = "MissingAssetError";
  }
}

export class MissingFieldError extends Error {
  constructor(field: string) {
    super(`required structured field '${field}' is absent; the brain must emit it`);
    this.name = "MissingFieldError";
  }
}

// ─── Layout types (fractional 0..1, resolution-independent) ────────────────────

interface Region {
  role: "logo" | "product" | "qr";
  x: number;
  y: number;
  w: number;
  h: number;
  // contain = preserve aspect, no crop (the default for fidelity assets).
  fit?: "contain";
}

interface TextSpec {
  source: "client_name" | "business_name" | "custom";
  text?: string; // when source === 'custom'
  x: number; // anchor x (fraction)
  y: number; // baseline y (fraction)
  fontFrac: number; // font size as a fraction of canvas height
  colorKey: "fg" | "accent"; // resolved from the palette
  weight?: number;
  anchor?: "start" | "middle" | "end";
}

export interface Template {
  id: string; // "banner_standard.A"
  product_type: string;
  // Preview resolution. A separate, higher-DPI print-ready render is a later
  // step; it reuses these regions and the same coarseUsable asset floor.
  canvasPx: { w: number; h: number };
  defaultPalette: Palette;
  regions: Region[];
  text: TextSpec[];
}

export interface Palette {
  bg: string;
  fg: string;
  accent: string;
}

// ─── Phase 1 template registry ─────────────────────────────────────────────────
// Two treatments per product_type give the A/B pair the client chooses between.
// Add product types here; unknown types fall back to GENERIC.

const BANNER_A: Template = {
  id: "banner_standard.A",
  product_type: "banner_standard",
  canvasPx: { w: 3000, h: 1200 }, // 10:4 aspect, preview scale
  defaultPalette: { bg: "#F2F2F2", fg: "#1B2A4A", accent: "#C8A24B" },
  regions: [
    { role: "logo", x: 0.04, y: 0.18, w: 0.22, h: 0.64 },
    { role: "product", x: 0.32, y: 0.12, w: 0.36, h: 0.76 },
    { role: "qr", x: 0.78, y: 0.22, w: 0.18, h: 0.56 },
  ],
  text: [
    { source: "business_name", x: 0.5, y: 0.12, fontFrac: 0.09, colorKey: "fg", weight: 700, anchor: "middle" },
  ],
};

const BANNER_B: Template = {
  id: "banner_standard.B",
  product_type: "banner_standard",
  canvasPx: { w: 3000, h: 1200 },
  defaultPalette: { bg: "#FFFFFF", fg: "#1B2A4A", accent: "#C8A24B" },
  regions: [
    { role: "logo", x: 0.06, y: 0.1, w: 0.3, h: 0.34 },
    { role: "product", x: 0.06, y: 0.5, w: 0.62, h: 0.42 },
    { role: "qr", x: 0.74, y: 0.32, w: 0.2, h: 0.5 },
  ],
  text: [
    { source: "business_name", x: 0.06, y: 0.5, fontFrac: 0.08, colorKey: "fg", weight: 700, anchor: "start" },
  ],
};

const GENERIC_A: Template = {
  ...BANNER_A,
  id: "generic.A",
  product_type: "generic",
};
const GENERIC_B: Template = {
  ...BANNER_B,
  id: "generic.B",
  product_type: "generic",
};

const REGISTRY: Record<string, { A: Template; B: Template }> = {
  banner_standard: { A: BANNER_A, B: BANNER_B },
  generic: { A: GENERIC_A, B: GENERIC_B },
};

// ─── job_spec readers (structured only) ────────────────────────────────────────
// These read STRUCTURED fields. They never parse `description`. Phase 2 generative
// fields (theme/style/color_palette) are read here too so the seam is ready.

export interface JobSpec {
  specs?: {
    description?: string; // brain input only — intentionally unused here
    product_type?: string;
    colors?: string[]; // hex[] — structured palette (brain should emit)
    qr_content?: string; // e.g. https://wa.me/<number> (brain should emit)
  };
  elements?: ElementSpec[]; // per-element layout overrides (position/size/color)
  // Phase 2 (read but ignored by Phase 1 composeBase):
  theme?: string;
  style?: string;
  color_palette?: string[];
  [k: string]: unknown;
}

// ─── Element ID helpers ────────────────────────────────────────────────────────
// Stable, canonical IDs derived from region role / text position in the template.
// Must be consistent between buildInitialElements and the composite loop.

export function regionElementId(r: { role: string }): string {
  return `${r.role}_main`; // logo_main | product_main | qr_main
}

export function textElementId(_t: { source: string }, idx: number): string {
  if (idx === 0) return "text_headline";
  return `text_${idx}`;
}

// ─── Element builder ───────────────────────────────────────────────────────────
// Extracts the template's element layout as ElementSpec defaults with no overrides.
// Stored in job_spec.elements at first mockup generation so revisions can override.

export function buildInitialElements(tpl: Template): ElementSpec[] {
  const elements: ElementSpec[] = [];
  for (const r of tpl.regions) {
    elements.push({
      element_id: regionElementId(r),
      type: "image",
      locked: true,
      position: { x: r.x, y: r.y },
      size: { width: r.w, height: r.h },
    });
  }
  tpl.text.forEach((t, idx) => {
    elements.push({
      element_id: textElementId(t, idx),
      type: "text",
      locked: true,
      position: { x: t.x, y: t.y },
      size: { width: t.fontFrac, height: t.fontFrac },
      font: { family: "DejaVu Sans", weight: t.weight ?? 400, size_points: 0 },
    });
  });
  return elements;
}

// Looks up the template pair for a product type and builds initial elements from
// the A variant (canonical layout). Used by action-applier on first generation.
export function buildInitialElementsForProductType(productType: string): ElementSpec[] {
  const pair = REGISTRY[productType] ?? REGISTRY["generic"]!;
  return buildInitialElements(pair.A);
}

// ─── mergeElementSpec ──────────────────────────────────────────────────────────
// Merges a template-default ElementSpec with a job_spec override.
// Override wins on all layout/style properties; content fields are ALWAYS from base.
//
// Content lock invariant: asset_id and content are locked — they are reference
// fields only and the compositor never reads them for actual rendering. Assets
// always come from AssetStore; text always comes from the Order row.

export function mergeElementSpec(base: ElementSpec, override: ElementSpec): ElementSpec {
  return {
    element_id: base.element_id,
    type: base.type,
    locked: base.locked,
    // Content — always from base (locked); override values silently ignored
    content: base.content,
    asset_id: base.asset_id,
    // Layout — override wins if present
    position: override.position ?? base.position,
    size: override.size ?? base.size,
    // Font — field-level merge (override's fields win; missing fields from base)
    font:
      override.font !== undefined
        ? { ...(base.font ?? { family: "DejaVu Sans", weight: 400, size_points: 0 }), ...override.font }
        : base.font,
    // Style — override wins if present
    color: override.color ?? base.color,
    opacity: override.opacity ?? base.opacity,
  };
}

function readJobSpec(order: Order): JobSpec {
  const raw = (order as { job_spec?: unknown }).job_spec;
  if (!raw) return {};
  return typeof raw === "string" ? (JSON.parse(raw) as JobSpec) : (raw as JobSpec);
}

function resolvePalette(spec: JobSpec, tpl: Template): Palette {
  const colors = spec.specs?.colors ?? spec.color_palette;
  if (!colors || colors.length === 0) return tpl.defaultPalette;
  return {
    bg: colors[0] ?? tpl.defaultPalette.bg,
    fg: colors[1] ?? tpl.defaultPalette.fg,
    accent: colors[2] ?? tpl.defaultPalette.accent,
  };
}

// ─── The compositor ────────────────────────────────────────────────────────────

export class SharpCompositor implements MockupPipeline {
  private readonly artGen: ArtGenerator;

  constructor(
    private readonly deps: {
      assets: AssetStore;
      sink: MockupSink;
      artGenerator?: ArtGenerator; // defaults to Phase1Base
      registry?: Record<string, { A: Template; B: Template }>;
    },
  ) {
    this.artGen = deps.artGenerator ?? new Phase1Base();
  }

  async generate(order: Order, variant: Variant, brief: string): Promise<MockupUrls> {
    // ONE composite per variant. variant 'both' => exactly A and B (2 images,
    // 1 spend-equivalent), never the old A/A_alt/B/B_alt fan-out.
    const which: Array<"A" | "B"> = variant === "both" ? ["A", "B"] : [variant];
    const out: MockupUrls = {};
    for (const v of which) {
      const tpl = this.pickTemplate(order, v);
      const png = await this.composite(order, tpl, brief);
      out[v] = await this.deps.sink.write(order, v, png);
    }
    return out;
  }

  private pickTemplate(order: Order, v: "A" | "B"): Template {
    const spec = readJobSpec(order);
    const pt = spec.specs?.product_type ?? "generic";
    const set = this.deps.registry?.[pt] ?? REGISTRY[pt] ?? { A: GENERIC_A, B: GENERIC_B };
    return set[v];
  }

  private async composite(order: Order, tpl: Template, brief: string): Promise<Buffer> {
    const spec = readJobSpec(order);
    const palette = resolvePalette(spec, tpl);
    const { w: W, h: H } = tpl.canvasPx;
    const specElements = spec.elements ?? [];

    // 1. Base — the pluggable seam (Phase 2 swaps the body of composeBase).
    const base = await this.composeBase(order, tpl, palette, brief);

    // 2. Fidelity overlays — merge template defaults with job_spec element overrides.
    const layers: OverlayOptions[] = [];
    for (const r of tpl.regions) {
      const eid = regionElementId(r);
      const templateEl: ElementSpec = {
        element_id: eid, type: "image", locked: true,
        position: { x: r.x, y: r.y }, size: { width: r.w, height: r.h },
      };
      const override = specElements.find(e => e.element_id === eid);
      const merged = override ? mergeElementSpec(templateEl, override) : templateEl;
      const placed = await this.placeRegion(order, spec, r, merged, W, H);
      if (placed) layers.push(placed);
    }

    // 3. Text — one full-canvas SVG per block, composited at origin.
    for (let idx = 0; idx < tpl.text.length; idx++) {
      const t = tpl.text[idx]!;
      const eid = textElementId(t, idx);
      const templateEl: ElementSpec = {
        element_id: eid, type: "text", locked: true,
        position: { x: t.x, y: t.y },
        size: { width: t.fontFrac, height: t.fontFrac },
        font: { family: "DejaVu Sans", weight: t.weight ?? 400, size_points: 0 },
      };
      const override = specElements.find(e => e.element_id === eid);
      const merged = override ? mergeElementSpec(templateEl, override) : templateEl;
      const svg = this.renderTextSvg(order, t, merged, palette, W, H);
      if (svg) layers.push({ input: svg, top: 0, left: 0 });
    }

    return sharp(base).composite(layers).png().toBuffer();
  }

  // Delegates to the injected ArtGenerator (Phase1Base or GptImage1Generator).
  private composeBase(order: Order, tpl: Template, palette: Palette, brief: string): Promise<Buffer> {
    const spec = readJobSpec(order);
    return this.artGen.generateArt(spec, tpl, palette, brief);
  }

  private async placeRegion(
    order: Order,
    spec: JobSpec,
    r: Region,
    merged: ElementSpec, // element with layout overrides applied
    W: number,
    H: number,
  ): Promise<OverlayOptions | null> {
    // Layout from merged element (override wins) — NEVER from merged.asset_id (content lock)
    const rx = merged.position?.x ?? r.x;
    const ry = merged.position?.y ?? r.y;
    const rw = merged.size?.width ?? r.w;
    const rh = merged.size?.height ?? r.h;
    const boxW = Math.round(rw * W);
    const boxH = Math.round(rh * H);
    const boxLeft = Math.round(rx * W);
    const boxTop = Math.round(ry * H);

    if (r.role === "qr") {
      const content = spec.specs?.qr_content;
      if (!content) return null; // optional — client may not provide a QR link
      const side = Math.min(boxW, boxH);
      const buf = await QRCode.toBuffer(content, { type: "png", width: side, margin: 1 });
      return this.center(buf, side, side, boxLeft, boxTop, boxW, boxH);
    }

    // logo | product — resolved by role, gated, contained (no crop).
    const role: AssetType = r.role as AssetType;
    const asset = this.resolveByRole(order, role);
    if (!asset) {
      // A logo region with no logo is a real gap; a missing product is too.
      throw new MissingAssetError(role, order.whatsapp_jid);
    }
    if (!coarseUsable(asset)) {
      throw new AssetGateError(role, asset);
    }

    const fitted = await sharp(asset.content)
      .resize(boxW, boxH, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    const meta = await sharp(fitted).metadata();
    return this.center(fitted, meta.width ?? boxW, meta.height ?? boxH, boxLeft, boxTop, boxW, boxH);
  }

  private resolveByRole(order: Order, role: AssetType): ResolvedAsset | null {
    if (role === ("logo" as AssetType)) return this.deps.assets.resolveLogo(order.whatsapp_jid, "current");
    return this.deps.assets.resolveAsset(order.whatsapp_jid, role, "current");
  }

  private center(
    buf: Buffer,
    bw: number,
    bh: number,
    boxLeft: number,
    boxTop: number,
    boxW: number,
    boxH: number,
  ): OverlayOptions {
    return {
      input: buf,
      left: boxLeft + Math.round((boxW - bw) / 2),
      top: boxTop + Math.round((boxH - bh) / 2),
    };
  }

  private renderTextSvg(
    order: Order,
    t: TextSpec,
    merged: ElementSpec, // element with layout/style overrides applied
    palette: Palette,
    W: number,
    H: number,
  ): Buffer | null {
    // Content ALWAYS from Order row, NEVER from merged.content (content lock).
    const text =
      t.source === "custom"
        ? t.text
        : t.source === "client_name"
          ? order.client_name
          : order.business_name;
    if (!text) return null; // optional text simply absent — not an error

    // Layout and style from merged element (override wins, template is fallback).
    const fontFrac = merged.size?.height ?? t.fontFrac;
    // If merged element specifies absolute size_points (> 0), use it; else derive from fontFrac.
    const size =
      (merged.font?.size_points && merged.font.size_points > 0)
        ? merged.font.size_points
        : Math.round(fontFrac * H);
    const x = Math.round((merged.position?.x ?? t.x) * W);
    const y = Math.round((merged.position?.y ?? t.y) * H);
    // Direct hex from override; else resolve from palette as usual.
    const fill = merged.color ?? (t.colorKey === "accent" ? palette.accent : palette.fg);
    const weight = merged.font?.weight ?? t.weight ?? 400;
    const anchor = t.anchor ?? "start";

    // System font stack; ensure a sans family is installed on the box, else the
    // renderer silently substitutes. Worth a fontconfig check at deploy.
    const svg =
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" ` +
      `font-size="${size}" font-weight="${weight}" fill="${fill}" ` +
      `text-anchor="${anchor}">${escapeXml(text)}</text></svg>`;
    return Buffer.from(svg);
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Default filesystem sink ───────────────────────────────────────────────────
// Writes the PNG to a served directory and returns its public URL. Path and base
// URL are injected — no hard-coded host assumptions in the compositor itself.

export class FilesystemMockupSink implements MockupSink {
  constructor(
    private readonly dir: string, // e.g. /var/www/mockups
    private readonly publicBaseUrl: string, // e.g. https://sovereigntysolutions.org/mockups
  ) {}

  async write(order: Order, variant: "A" | "B", png: Buffer): Promise<string> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const safeJid = order.whatsapp_jid.replace(/[^a-zA-Z0-9._-]/g, "_");
    const name = `${safeJid}_${Date.now()}_${variant}.png`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, name), png);
    return `${this.publicBaseUrl.replace(/\/$/, "")}/${name}`;
  }
}
