// test/pricing.test.ts
// Unit tests for every new/changed price path in src/pricing/pricing.ts.
// Run: npm run test:pricing

import assert from "node:assert";
import {
  computePrice,
  MIN_CENTS,
  CUT_VINYL_MIN_CENTS,
  UV_UPCHARGE_PER_SQFT,
  CUT_VINYL_BASE_PER_SQFT,
  CUT_VINYL_LAYER_UPCHARGE,
  UNIT_LADDER,
  UNIT_BASE_PRICES,
  UNIT_LADDER_OVERRIDES,
  roundToNickel,
} from "../src/pricing/pricing.js";
import { ActionApplier, ApplyDeps } from "../src/brain/action-applier.js";
import { Store, NewEvent, NewPayment, Quote, IdempotencyCollision } from "../src/store/store.js";
import { Order, OrderState, Payment, PaymentStatus, EventRow, ClientPaymentKind } from "../src/domain/types.js";
import { Clock, IdGen } from "../src/domain/ports.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { PaymentProvider, ChargeArgs, ChargeResult, usdOnlyFx } from "../src/payments/providers.js";
import { Notifier } from "../src/domain/integrations.js";
import { assertTransition } from "../src/domain/state-machine.js";
import { AssetStore } from "../src/store/asset-store.js";

// ── harness ───────────────────────────────────────────────────────────────────

let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

class SeqClock implements Clock {
  private t = 1_700_000_000_000;
  nowIso() { return new Date((this.t += 1000)).toISOString(); }
  nowMs() { return this.t; }
}
class SeqId implements IdGen {
  private n = 0;
  next() { return `id-${++this.n}`; }
}

class FakeStore implements Store {
  orders = new Map<string, Order>();
  payments: Payment[] = [];
  events: EventRow[] = [];
  quotes: Quote[] = [];
  constructor(private clock: Clock, private ids: IdGen) {}

  createOrder(jid: string): Order {
    const now = this.clock.nowIso();
    const o: Order = {
      order_id: this.ids.next(), created_at: now, updated_at: now,
      whatsapp_jid: jid, client_name: null, business_name: null,
      project_type: null, job_spec: null, track: "undecided",
      selected_mockup: null, state: "intake", dormant_since: null,
      follow_up_stage: 0, escalation: null, dispute_flag: 0,
      failed_mockup_pairs: 0, digital_rounds_used: 0,
      assigned_supplier_id: null, hermes_session_id: null,
      turn_count: 0, last_tier: null, force_tier: null, notes: null,
    };
    this.orders.set(o.order_id, o);
    return { ...o };
  }
  getOrder(id: string) { const o = this.orders.get(id); return o ? { ...o } : null; }
  findActiveOrderByJid(jid: string) {
    const list = [...this.orders.values()].filter(
      (o) => o.whatsapp_jid === jid && !["closed","cancelled","forfeited"].includes(o.state),
    );
    return list.length ? { ...list[list.length - 1]! } : null;
  }
  patchOrder(id: string, patch: Partial<Order>) {
    const o = this.orders.get(id);
    if (!o) throw new Error("no order");
    Object.assign(o, patch, { updated_at: this.clock.nowIso() });
    return { ...o };
  }
  transition(id: string, to: OrderState, payload?: unknown) {
    const o = this.orders.get(id);
    if (!o) throw new Error("no order");
    assertTransition(o.state, to);
    this.appendEvent({ order_id: id, actor: "flock", type: "state_change", payload: { from: o.state, to } });
    o.state = to; o.updated_at = this.clock.nowIso(); void payload;
    return { ...o };
  }
  insertPendingPayment(p: NewPayment): Payment {
    if (this.payments.some((x) => x.idempotency_key === p.idempotency_key)) throw new IdempotencyCollision(p.idempotency_key);
    const row: Payment = { payment_id: this.ids.next(), created_at: this.clock.nowIso(), status: "pending", external_ref: null, ...p };
    this.payments.push(row); return { ...row };
  }
  getPaymentByKey(key: string) { const p = this.payments.find((x) => x.idempotency_key === key); return p ? { ...p } : null; }
  getPayment(id: string) { const p = this.payments.find((x) => x.payment_id === id); return p ? { ...p } : null; }
  markPaymentStatus(id: string, status: PaymentStatus, ref?: string | null) {
    const p = this.payments.find((x) => x.payment_id === id)!;
    p.status = status; if (ref !== undefined) p.external_ref = ref; return { ...p };
  }
  markPaymentStatusIfPending(id: string, status: PaymentStatus, ref?: string | null) {
    const p = this.payments.find((x) => x.payment_id === id);
    if (!p || p.status !== "pending") return { changes: 0, payment: p ? { ...p } : null };
    p.status = status; if (ref !== undefined) p.external_ref = ref; return { changes: 1, payment: { ...p } };
  }
  db = { transaction: (fn: () => void) => fn };
  listPayments(orderId: string) { return this.payments.filter((x) => x.order_id === orderId).map((x) => ({ ...x })); }
  pendingClientPaymentKind(orderId: string): ClientPaymentKind | "none" {
    const p = this.payments.find((x) => x.order_id === orderId && x.direction === "in" && x.status === "pending" && ["deposit","balance","digital"].includes(x.kind));
    return (p?.kind as ClientPaymentKind) ?? "none";
  }
  hasHeldMoney(orderId: string) { return this.payments.some((x) => x.order_id === orderId && x.direction === "in" && x.status === "succeeded"); }
  succeededDigitalBlocks(orderId: string) { return this.payments.filter((x) => x.order_id === orderId && x.kind === "digital" && x.direction === "in" && x.status === "succeeded").length; }
  succeededRevisionBlocks(orderId: string) { return this.payments.filter((x) => x.order_id === orderId && x.kind === "revision" && x.direction === "in" && x.status === "succeeded").length; }
  appliedRevisions(orderId: string) { return this.events.filter((e) => e.order_id === orderId && e.type === "revision_applied").length; }
  recordRevisionEvent(orderId: string, inboundEventId: string) { this.appendEvent({ order_id: orderId, actor: "flock", type: "revision_applied", inbound_event_id: inboundEventId }); }
  appendEvent(e: NewEvent): EventRow {
    const row: EventRow = { event_id: this.ids.next(), order_id: e.order_id, created_at: this.clock.nowIso(), actor: e.actor, type: e.type, payload: e.payload === undefined ? null : JSON.stringify(e.payload), inbound_event_id: e.inbound_event_id ?? null };
    this.events.push(row); return { ...row };
  }
  findUnansweredInbound() { return this.events.filter((ev) => ev.type === "msg_recv" && !this.events.some((r) => r.type === "msg_sent" && r.inbound_event_id === ev.event_id)); }
  findPendingPaymentsWithExternalRef() { return this.payments.filter((p) => p.status === "pending" && p.external_ref); }
  findOrphanedPendingPayments() { return this.payments.filter((p) => p.status === "pending" && !p.external_ref && p.direction === "in"); }
  getLastClientMessageTime(orderId: string): string | null {
    const recvs = this.events.filter((e) => e.order_id === orderId && e.type === "msg_recv");
    if (recvs.length === 0) return null;
    return recvs.reduce((max, e) => (e.created_at > max ? e.created_at : max), recvs[0]!.created_at);
  }
  inboundHasReply(id: string) { return this.events.some((r) => r.type === "msg_sent" && r.inbound_event_id === id); }
  getConversationHistory(orderId: string, limit = 10) {
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const ev of this.events.filter((e) => e.order_id === orderId && (e.type === "msg_recv" || e.type === "msg_sent"))) {
      try {
        const p = ev.payload ? (JSON.parse(ev.payload) as { text?: string; silent?: boolean }) : {};
        if (ev.type === "msg_recv" && p.text) turns.push({ role: "user", content: p.text });
        else if (ev.type === "msg_sent" && !p.silent && p.text) turns.push({ role: "assistant", content: p.text });
      } catch { /* skip */ }
    }
    return turns.slice(-(limit * 2));
  }
  getSelectedQuote(orderId: string) { return this.quotes.find((q) => q.order_id === orderId && q.status === "selected") ?? null; }
  findQuietOrders(quietSinceIso: string) { return [...this.orders.values()].filter((o) => !["closed","cancelled","forfeited"].includes(o.state) && (o.updated_at <= quietSinceIso || o.dormant_since !== null)); }
  setDormancy(id: string, dormantSince: string | null, stage: number) { const o = this.orders.get(id)!; o.dormant_since = dormantSince; o.follow_up_stage = stage; return { ...o }; }
  getLastRejectedAction(orderId: string): string | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!;
      if (ev.order_id !== orderId || ev.type !== "state_change") continue;
      try { const p = ev.payload ? (JSON.parse(ev.payload) as { rejected_action?: { type?: string } }) : null; if (p?.rejected_action?.type) return p.rejected_action.type; } catch { /* skip */ }
    }
    return null;
  }
  close() {}
}

class FakeProvider implements PaymentProvider {
  readonly method = "stripe" as const;
  charges = 0;
  async charge(_a: ChargeArgs): Promise<ChargeResult> { this.charges++; return { status: "pending" }; }
}

class TrackingNotifier implements Notifier {
  calls: string[] = [];
  async postToPenn(text: string) { this.calls.push(text); }
}

const fakeAssetStore = {
  pendingAssets: () => [],
  resolveLogo: () => null,
  resolveAsset: () => null,
  writeAsset: async () => "fake-id",
  confirmAssetRole: () => {},
  resolveAssetMeta: () => null,
  resolvePendingByRef: () => null,
} as unknown as AssetStore;

function makeApplier(store: Store, notifier: Notifier) {
  const clock = new SeqClock();
  const payments = new PaymentOps(store, new FakeProvider(), usdOnlyFx, clock);
  return new ActionApplier({
    store, payments,
    mockups: { async generate() { return { A: "a.png", B: "b.png" }; } },
    supplierQueue: { async queueRevision() {} },
    delivery: { async deliverFinal() { return { url: "final.pdf" }; } },
    notifier,
    clock,
    defaultMethod: "stripe",
    assetStore: fakeAssetStore,
  });
}

// ── MIN_CENTS ─────────────────────────────────────────────────────────────────

test("MIN_CENTS is $20", () => {
  assert.equal(MIN_CENTS, 2000, "MIN_CENTS must be 2000 cents ($20)");
});

test("small order hits $20 floor, not $150", () => {
  // 1 DTF transfer at $8 = $8 gross → floor lifts to $20
  const r = computePrice({ product_type: "dtf_transfer", quantity: 1 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 2000, "1 DTF transfer must be floored at $20");
});

// ── tumbler ───────────────────────────────────────────────────────────────────

test("tumbler: qty 1 = $40", () => {
  const r = computePrice({ product_type: "tumbler", quantity: 1 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 4000);
});

test("tumbler: qty 5 = $180 ($36 each, ladder 0.90)", () => {
  // $40 × 0.90 × 5 = $180
  const r = computePrice({ product_type: "tumbler", quantity: 5 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 18000);
});

test("tumbler: qty 25 = $750 ($30 each, ladder 0.75)", () => {
  // $40 × 0.75 × 25 = $750
  const r = computePrice({ product_type: "tumbler", quantity: 25 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 75000);
});

test("tumbler: qty 100 = $2600 ($26 each, ladder 0.65)", () => {
  // $40 × 0.65 × 100 = $2600
  const r = computePrice({ product_type: "tumbler", quantity: 100 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 260000);
});

// ── stickers ──────────────────────────────────────────────────────────────────

test("sticker: 1000 run = $90", () => {
  const r = computePrice({ product_type: "sticker", quantity: 1000 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 9000);
});

test("sticker: qty < 1000 still charges the 1000-run minimum", () => {
  const r = computePrice({ product_type: "sticker", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 9000, "500 stickers should charge the 1000-run floor");
});

test("sticker: qty > 1000 escalates (no sub-runs above 1000)", () => {
  const r = computePrice({ product_type: "sticker", quantity: 2000 });
  assert.ok(!r.ok);
  assert.ok(!r.ok && r.requiresDanApproval, "over-1000 sticker order should escalate");
});

// ── cut vinyl ─────────────────────────────────────────────────────────────────

test("cut vinyl: constants are correct", () => {
  assert.equal(CUT_VINYL_BASE_PER_SQFT, 8);
  assert.equal(CUT_VINYL_LAYER_UPCHARGE, 2);
  assert.equal(CUT_VINYL_MIN_CENTS, 4000);
});

test("cut vinyl: 1 sqft single color = $8, floor to $40", () => {
  const r = computePrice({ product_type: "cut_vinyl", sqft: 1 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, CUT_VINYL_MIN_CENTS, "1 sqft must hit $40 minimum");
});

test("cut vinyl: 5 sqft, 1 color = $40 (floor applies)", () => {
  // 5 sqft × $8 = $40 exactly
  const r = computePrice({ product_type: "cut_vinyl", sqft: 5 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 4000);
});

test("cut vinyl: 10 sqft, 1 color = $80", () => {
  const r = computePrice({ product_type: "cut_vinyl", sqft: 10 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 8000);
});

test("cut vinyl: 10 sqft, 2 colors = $100 ($10/sqft)", () => {
  // $8 + $2 = $10/sqft × 10 = $100
  const r = computePrice({ product_type: "cut_vinyl", sqft: 10, num_colors: 2 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 10000);
});

test("cut vinyl: 10 sqft, 3 colors = $120 ($12/sqft)", () => {
  // $8 + $4 = $12/sqft × 10 = $120
  const r = computePrice({ product_type: "cut_vinyl", sqft: 10, num_colors: 3 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 12000);
});

test("cut vinyl: dimension-derived sqft", () => {
  // 4ft × 2ft = 8 sqft × $8 = $64
  const r = computePrice({ product_type: "cut_vinyl", width_ft: 4, height_ft: 2 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 6400);
});

test("cut vinyl: no sqft → not yet collected, not escalated", () => {
  const r = computePrice({ product_type: "cut_vinyl" });
  assert.ok(!r.ok);
  assert.ok(!r.ok && !r.requiresDanApproval);
});

test("cut vinyl: rush order applies urgency multiplier", () => {
  // 10 sqft × $8 × 1.5 = $120
  const r = computePrice({ product_type: "cut_vinyl", sqft: 10, turnaround_days: 2 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 12000);
});

// ── UV upcharge ───────────────────────────────────────────────────────────────

test("UV_UPCHARGE_PER_SQFT is $2", () => {
  assert.equal(UV_UPCHARGE_PER_SQFT, 2);
});

test("banner_standard without UV: 32 sqft = $176 ($5.50/sqft, 25–99 tier)", () => {
  // 32 sqft falls in the 25–99 tier at $5.50/sqft → 32 × $5.50 = $176
  const r = computePrice({ product_type: "banner_standard", sqft: 32 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 17600);
});

test("banner_standard with UV: 32 sqft = $176 + $64 = $240", () => {
  // base: 32 × $5.50 = $176; UV: 32 × $2 = $64; total = $240
  const r = computePrice({ product_type: "banner_standard", sqft: 32, uv_resistant: true });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 24000);
});

test("mesh with UV: 10 sqft = $60 + $20 = $80", () => {
  // base: 10 × $6 = $60; UV: 10 × $2 = $20; total = $80
  const r = computePrice({ product_type: "vinyl_mesh_materials", sqft: 10, uv_resistant: true });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 8000);
});

test("UV upcharge is not urgency-scaled: rush banner UV is base×1.5 + UV flat", () => {
  // rush banner 10 sqft: base = 10 × $6 × 1.5 = $90; UV flat = 10 × $2 = $20; total = $110
  const r = computePrice({ product_type: "banner_standard", sqft: 10, uv_resistant: true, turnaround_days: 2 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 11000);
});

test("banner_uv no longer a product type", () => {
  // banner_uv was removed as a standalone product; should now be unknown
  const r = computePrice({ product_type: "banner_uv", sqft: 10 });
  assert.ok(!r.ok);
  assert.ok(!r.ok && !r.requiresDanApproval && r.reason.includes("unknown"));
});

// ── flat print 100/500 sub-runs ───────────────────────────────────────────────

test("BC with design: 100 run = $45", () => {
  const r = computePrice({ product_type: "business_cards", print_variant: "with_design", quantity: 100 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 4500);
});

test("BC with design: 500 run = $112.50", () => {
  const r = computePrice({ product_type: "business_cards", print_variant: "with_design", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 11250);
});

test("BC with design: 1000 run = $150", () => {
  const r = computePrice({ product_type: "business_cards", print_variant: "with_design", quantity: 1000 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 15000);
});

test("flyer: 100 run = $52.50", () => {
  const r = computePrice({ product_type: "flyer", quantity: 100 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 5250);
});

test("flyer: 500 run = $131.25", () => {
  const r = computePrice({ product_type: "flyer", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 13125);
});

test("tabloid: 100 run = $97.50", () => {
  const r = computePrice({ product_type: "tabloid", quantity: 100 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 9750);
});

test("tabloid: 500 run = $243.75", () => {
  const r = computePrice({ product_type: "tabloid", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 24375);
});

test("brochure: 100 run = $85.50", () => {
  const r = computePrice({ product_type: "brochure", quantity: 100 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 8550);
});

test("brochure: 500 run = $213.75", () => {
  const r = computePrice({ product_type: "brochure", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 21375);
});

// ── BC print-only $39 ─────────────────────────────────────────────────────────

test("BC print-only: 1000 = $39", () => {
  const r = computePrice({ product_type: "business_cards", print_variant: "print_only", quantity: 1000 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 3900);
});

test("BC print-only: qty 500 still rounds up to the 1000-run tier ($39)", () => {
  const r = computePrice({ product_type: "business_cards", print_variant: "print_only", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 3900);
});

test("BC print-only: no 100-run tier (only 1000 available)", () => {
  // At qty 100, the smallest run >= 100 is 1000 → $39
  const r = computePrice({ product_type: "business_cards", print_variant: "print_only", quantity: 100 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 3900, "print-only has no 100/500 tiers — rounds up to 1000");
});

// ── feather flag escalates ────────────────────────────────────────────────────

test("feather_flag: requires Dan approval", () => {
  const r = computePrice({ product_type: "feather_flag" });
  assert.ok(!r.ok);
  assert.ok(!r.ok && r.requiresDanApproval);
  assert.ok(!r.ok && r.requiresDanApproval && r.productName.includes("Feather Flag"));
});

// ── >= $1000 observer notification ───────────────────────────────────────────

test("high-value quote notifies Penn (observer-only, non-blocking)", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const notifier = new TrackingNotifier();
  const app = makeApplier(store, notifier);

  const o = store.createOrder("client@wa");

  // Collect specs that produce a $1200 quote (e.g. tumbler × 30 = 25-tier × 30 = $24 × 30 = $720... not $1000)
  // Use banner_standard 200 sqft × $5/sqft = $1000 exactly → should notify
  await app.applyAll(o.order_id, [
    { type: "collect", fields: { product_type: "banner_standard", sqft: 200 } },
  ], "evt-1");

  const order = store.getOrder(o.order_id)!;
  const spec = JSON.parse(order.job_spec ?? "{}");
  assert.equal(spec.price_cents, 100000, "200 sqft banner = $1000");
  assert.ok(
    notifier.calls.some((c) => c.includes("high-value-quote")),
    "Penn must be notified of a $1000+ quote",
  );
});

test("sub-$1000 quote does NOT trigger Penn notification", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const notifier = new TrackingNotifier();
  const app = makeApplier(store, notifier);

  const o = store.createOrder("client@wa");
  // 10 sqft banner = $60
  await app.applyAll(o.order_id, [
    { type: "collect", fields: { product_type: "banner_standard", sqft: 10 } },
  ], "evt-1");

  assert.ok(
    !notifier.calls.some((c) => c.includes("high-value-quote")),
    "Penn must NOT be notified for sub-$1000 quotes",
  );
});

// ── Increment 2: shared ladder, parked products, nickel rounding ─────────────

test("UNIT_LADDER has 5 breakpoints: 1/5/25/100/500", () => {
  const mins = UNIT_LADDER.map(([m]) => m);
  assert.deepEqual(mins, [1, 5, 25, 100, 500]);
  const mults = UNIT_LADDER.map(([, m]) => m);
  assert.deepEqual(mults, [1.00, 0.90, 0.75, 0.65, 0.55]);
});

test("ladder: qty < 5 uses tier-1 (1.00x)", () => {
  // t-shirt qty=3: $30 × 1.00 × 3 = $90
  const r = computePrice({ product_type: "tshirt", quantity: 3 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 9000);
});

test("ladder: qty=5 triggers tier-2 (0.90x)", () => {
  // t-shirt qty=5: $30 × 0.90 × 5 = $135
  const r = computePrice({ product_type: "tshirt", quantity: 5 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 13500);
});

test("ladder: qty between 5 and 25 stays at tier-2 (0.90x)", () => {
  // t-shirt qty=10: $30 × 0.90 × 10 = $270
  const r = computePrice({ product_type: "tshirt", quantity: 10 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 27000);
});

test("ladder: qty=25 triggers tier-3 (0.75x)", () => {
  // t-shirt qty=25: $30 × 0.75 × 25 = $562.50
  const r = computePrice({ product_type: "tshirt", quantity: 25 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 56250);
});

test("ladder: qty=100 triggers tier-4 (0.65x)", () => {
  // t-shirt qty=100: $30 × 0.65 × 100 = $1950
  const r = computePrice({ product_type: "tshirt", quantity: 100 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 195000);
});

test("ladder: qty=500 triggers tier-5 (0.55x)", () => {
  // t-shirt qty=500: $30 × 0.55 × 500 = $8250
  const r = computePrice({ product_type: "tshirt", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 825000);
});

test("ladder: qty=501 stays at tier-5 (0.55x)", () => {
  // t-shirt qty=501: $30 × 0.55 × 501 = $8266.50 → 826650
  const r = computePrice({ product_type: "tshirt", quantity: 501 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 826650);
});

test("tumbler qty=500 uses tier-5 (0.55x): $22/unit", () => {
  // $40 × 0.55 × 500 = $11000
  const r = computePrice({ product_type: "tumbler", quantity: 500 });
  assert.ok(r.ok);
  assert.equal(r.priceCents, 1100000);
});

// Verify all six ladder products produce expected qty-1 prices
test("all UNIT_BASE_PRICES keys are quotable", () => {
  for (const [key, base] of Object.entries(UNIT_BASE_PRICES)) {
    const r = computePrice({ product_type: key, quantity: 1 });
    assert.ok(r.ok, `${key} should be auto-priced`);
    assert.ok(r.ok && r.priceCents >= 0, `${key} priceCents should be >= 0`);
    // qty-1 price = base × 1.00 × 1; floored at MIN_CENTS
    const expected = Math.max(MIN_CENTS, Math.round(base * 100));
    assert.equal(r.ok && r.priceCents, expected, `${key} qty=1 should be $${base} (or floor)`);
  }
});

// ── parked products: flag and sky_dancer ─────────────────────────────────────

test("flag is parked → requires Dan approval", () => {
  const r = computePrice({ product_type: "flag" });
  assert.ok(!r.ok);
  assert.ok(!r.ok && r.requiresDanApproval, "flag must escalate, not auto-quote");
  assert.ok(!r.ok && r.requiresDanApproval && r.productName.includes("Flag"));
});

test("sky_dancer is parked → requires Dan approval", () => {
  const r = computePrice({ product_type: "sky_dancer" });
  assert.ok(!r.ok);
  assert.ok(!r.ok && r.requiresDanApproval, "sky_dancer must escalate, not auto-quote");
  assert.ok(!r.ok && r.requiresDanApproval && r.productName.toLowerCase().includes("sky dancer"));
});

// ── $0.05 rounding (roundToNickel) ───────────────────────────────────────────

test("roundToNickel: rounds up at midpoint", () => {
  assert.equal(roundToNickel(1003), 1005); // $10.03 → $10.05
  assert.equal(roundToNickel(1007), 1005); // $10.07 → $10.05
  assert.equal(roundToNickel(1008), 1010); // $10.08 → $10.10
});

test("roundToNickel: exact multiples unchanged", () => {
  assert.equal(roundToNickel(2000), 2000);
  assert.equal(roundToNickel(4500), 4500);
  assert.equal(roundToNickel(13500), 13500);
});

test("roundToNickel: rounds down when closer to lower nickel", () => {
  assert.equal(roundToNickel(1001), 1000); // $10.01 → $10.00
  assert.equal(roundToNickel(1002), 1000); // $10.02 → $10.00
});

test("computePrice output is always a multiple of 5 cents", () => {
  // Spot-check several products and quantities
  const cases: Parameters<typeof computePrice>[0][] = [
    { product_type: "tshirt", quantity: 7 },
    { product_type: "hat", quantity: 3, turnaround_days: 2 },
    { product_type: "mug", quantity: 50, turnaround_days: 5 },
    { product_type: "tumbler", quantity: 12 },
    { product_type: "dtf_transfer", quantity: 200, turnaround_days: 2 },
    { product_type: "banner_standard", sqft: 17 },
    { product_type: "cut_vinyl", sqft: 7, num_colors: 2, turnaround_days: 2 },
  ];
  for (const inputs of cases) {
    const r = computePrice(inputs);
    assert.ok(r.ok, `${JSON.stringify(inputs)} should price ok`);
    assert.equal(
      r.ok && r.priceCents % 5, 0,
      `${JSON.stringify(inputs)} → ${r.ok ? r.priceCents : "err"} must be divisible by 5`,
    );
  }
});

// ── override hook ─────────────────────────────────────────────────────────────

test("UNIT_LADDER_OVERRIDES: custom curve overrides standard ladder", () => {
  // Install a flat 50% override for tshirt, verify it's used, then remove it.
  UNIT_LADDER_OVERRIDES["tshirt"] = [[1, 0.50]];
  try {
    // $30 × 0.50 × 10 = $150
    const r = computePrice({ product_type: "tshirt", quantity: 10 });
    assert.ok(r.ok);
    assert.equal(r.priceCents, 15000, "override should override the standard ladder");
  } finally {
    delete UNIT_LADDER_OVERRIDES["tshirt"];
  }
  // Verify standard ladder restored
  const r2 = computePrice({ product_type: "tshirt", quantity: 10 });
  assert.ok(r2.ok);
  assert.equal(r2.priceCents, 27000, "standard ladder should be restored after override removed");
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
