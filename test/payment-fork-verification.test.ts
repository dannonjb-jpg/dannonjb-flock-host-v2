// test/payment-fork-verification.test.ts
// Verifies both post-payment forks (deposit → supplier handoff, $5 digital → AI loop)
// work correctly with the element-addressable spec (Increment 4).
//
// Parts:
//   A — Deposit fork: awaiting_decision → deposit_pending → revision (supplier-ready)
//   B — Digital fork: awaiting_decision → digital_pending → revision → closed
//   C — Integration seams (payment confirm, fork routing, element access)
//   D — Specific test scenarios (rounds math, content lock structural check, idempotency)

import assert from "node:assert/strict";

import {
  Order,
  OrderState,
  Payment,
  PaymentStatus,
  EventRow,
  ClientPaymentKind,
  ElementSpec,
  JobSpec,
} from "../src/domain/types.js";
import { canTransition, assertTransition } from "../src/domain/state-machine.js";
import { Store, NewEvent, NewPayment, Quote, IdempotencyCollision } from "../src/store/store.js";
import { Clock, IdGen } from "../src/domain/ports.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { PaymentProvider, ChargeArgs, ChargeResult, usdOnlyFx } from "../src/payments/providers.js";
import { ActionApplier } from "../src/brain/action-applier.js";
import { MockupPipeline, SupplierQueue, Delivery, Notifier, MockupUrls } from "../src/domain/integrations.js";
import { buildInitialElementsForProductType } from "../src/integrations/sharp-compositor.js";

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(
    () => { console.log(`  ✓ ${name}`); passed++; },
    (e: unknown) => { console.log(`  ✗ ${name}: ${(e as Error).message}`); failed++; },
  );
}

// ── deterministic clock + ids ─────────────────────────────────────────────────
class SeqClock implements Clock {
  private t = 1_750_000_000_000;
  nowIso() { return new Date((this.t += 1000)).toISOString(); }
  nowMs() { return this.t; }
}
class SeqId implements IdGen {
  private n = 0;
  next() { return `id-${++this.n}`; }
}

// ── FakeStore (full — extends core.test.ts version with revision + client stubs) ──
class FakeStore implements Store {
  orders = new Map<string, Order>();
  payments: Payment[] = [];
  events: EventRow[] = [];
  quotes: Quote[] = [];
  // Expose db transaction stub for PaymentOps.confirmInTransaction check
  db = { transaction: (fn: () => void) => fn, inTransaction: false };

  constructor(private clock: Clock, private ids: IdGen) {}

  // ── orders ─────────────────────────────────────────────────────────────────
  createOrder(jid: string): Order {
    const now = this.clock.nowIso();
    const o: Order = {
      order_id: this.ids.next(),
      created_at: now, updated_at: now,
      whatsapp_jid: jid,
      client_name: null, business_name: null, project_type: null, job_spec: null,
      track: "undecided", selected_mockup: null,
      state: "intake",
      dormant_since: null, follow_up_stage: 0,
      escalation: null, dispute_flag: 0,
      failed_mockup_pairs: 0, digital_rounds_used: 0,
      assigned_supplier_id: null, hermes_session_id: null,
      turn_count: 0, last_tier: null, force_tier: null, notes: null,
      // Fulfillment fields
      fulfillment_method: null, delivery_address: null,
      shipping_tier: null, shipping_cents: null, ready_to_ship_date: null,
    };
    this.orders.set(o.order_id, o);
    return { ...o };
  }
  getOrder(id: string): Order | null {
    const o = this.orders.get(id);
    return o ? { ...o } : null;
  }
  findActiveOrderByJid(jid: string): Order | null {
    const list = [...this.orders.values()].filter(
      o => !["closed", "cancelled", "forfeited"].includes(o.state) && o.whatsapp_jid === jid,
    );
    return list.length ? { ...list[list.length - 1]! } : null;
  }
  patchOrder(id: string, patch: Partial<Order>): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error(`no order ${id}`);
    Object.assign(o, patch, { updated_at: this.clock.nowIso() });
    return { ...o };
  }
  transition(id: string, to: OrderState, payload?: unknown): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error(`no order ${id}`);
    assertTransition(o.state, to);
    this.appendEvent({ order_id: id, actor: "flock", type: "state_change", payload: { from: o.state, to } });
    o.state = to;
    o.updated_at = this.clock.nowIso();
    void payload;
    return { ...o };
  }

  // ── client profile stubs (not exercised in fork tests) ───────────────────
  addOrUpdateClient(jid: string) {
    const now = this.clock.nowIso();
    return { client_id: this.ids.next(), whatsapp_jid: jid, created_at: now, updated_at: now };
  }
  getClientByJid(_jid: string) { return null; }
  getClientOrders(_jid: string): Order[] { return []; }

  // ── payments ───────────────────────────────────────────────────────────────
  insertPendingPayment(p: NewPayment): Payment {
    if (this.payments.some(x => x.idempotency_key === p.idempotency_key)) {
      throw new IdempotencyCollision(p.idempotency_key);
    }
    const row: Payment = {
      payment_id: this.ids.next(), created_at: this.clock.nowIso(),
      status: "pending", external_ref: null, ...p,
    };
    this.payments.push(row);
    return { ...row };
  }
  getPaymentByKey(key: string): Payment | null {
    const p = this.payments.find(x => x.idempotency_key === key);
    return p ? { ...p } : null;
  }
  getPayment(id: string): Payment | null {
    const p = this.payments.find(x => x.payment_id === id);
    return p ? { ...p } : null;
  }
  markPaymentStatus(id: string, status: PaymentStatus, ref?: string | null): Payment {
    const p = this.payments.find(x => x.payment_id === id)!;
    p.status = status;
    if (ref !== undefined) p.external_ref = ref;
    return { ...p };
  }
  markPaymentStatusIfPending(id: string, status: PaymentStatus, ref?: string | null): { changes: number; payment: Payment | null } {
    const p = this.payments.find(x => x.payment_id === id);
    if (!p || p.status !== "pending") return { changes: 0, payment: p ? { ...p } : null };
    p.status = status;
    if (ref !== undefined) p.external_ref = ref;
    return { changes: 1, payment: { ...p } };
  }
  listPayments(orderId: string): Payment[] {
    return this.payments.filter(x => x.order_id === orderId).map(x => ({ ...x }));
  }
  pendingClientPaymentKind(orderId: string): ClientPaymentKind | "none" {
    const p = this.payments.find(x =>
      x.order_id === orderId && x.direction === "in" && x.status === "pending" &&
      ["deposit", "balance", "digital"].includes(x.kind),
    );
    return (p?.kind as ClientPaymentKind) ?? "none";
  }
  hasHeldMoney(orderId: string): boolean {
    return this.payments.some(x => x.order_id === orderId && x.direction === "in" && x.status === "succeeded");
  }
  succeededDigitalBlocks(orderId: string): number {
    return this.payments.filter(x =>
      x.order_id === orderId && x.kind === "digital" && x.direction === "in" && x.status === "succeeded",
    ).length;
  }
  // Not in Store interface — duck-typed by action-applier for physical revisions
  succeededRevisionBlocks(orderId: string): number {
    return this.payments.filter(x =>
      x.order_id === orderId && x.kind === "revision" && x.direction === "in" && x.status === "succeeded",
    ).length;
  }
  appliedRevisions(orderId: string): number {
    const revEvents = this.events.filter(e => e.order_id === orderId && e.type === ("revision" as never));
    const unique = new Set(revEvents.map(e => e.inbound_event_id));
    return unique.size;
  }
  recordRevisionEvent(orderId: string, inboundEventId: string): void {
    const seen = this.events.some(e =>
      e.order_id === orderId && e.type === ("revision" as never) && e.inbound_event_id === inboundEventId,
    );
    if (!seen) {
      this.appendEvent({
        order_id: orderId, actor: "client", type: "revision" as never, inbound_event_id: inboundEventId,
      });
    }
  }
  listPendingManualPayments(): Payment[] {
    return this.payments.filter(p =>
      p.status === "pending" && p.method !== "stripe" && p.direction === "in",
    );
  }

  // ── events ─────────────────────────────────────────────────────────────────
  appendEvent(e: NewEvent): EventRow {
    const row: EventRow = {
      event_id: this.ids.next(), order_id: e.order_id,
      created_at: this.clock.nowIso(),
      actor: e.actor, type: e.type,
      payload: e.payload === undefined ? null : JSON.stringify(e.payload),
      inbound_event_id: e.inbound_event_id ?? null,
    };
    this.events.push(row);
    return { ...row };
  }
  getEvent(id: string): EventRow | null {
    return this.events.find(e => e.event_id === id) ?? null;
  }
  findUnansweredInbound(): EventRow[] {
    return this.events.filter(ev =>
      ev.type === "msg_recv" &&
      !this.events.some(r => r.type === "msg_sent" && r.inbound_event_id === ev.event_id),
    );
  }
  findPendingPaymentsWithExternalRef(): Payment[] {
    return this.payments.filter(p => p.status === "pending" && p.external_ref);
  }
  inboundHasReply(id: string): boolean {
    return this.events.some(r => r.type === "msg_sent" && r.inbound_event_id === id);
  }
  getConversationHistory(): { role: "user" | "assistant"; content: string }[] { return []; }
  getSelectedQuote(orderId: string): Quote | null {
    return this.quotes.find(q => q.order_id === orderId && q.status === "selected") ?? null;
  }

  // ── scheduler / watchdog stubs ─────────────────────────────────────────────
  findQuietOrders(_quietSinceIso: string): Order[] { return []; }
  setDormancy(id: string, dormantSince: string | null, stage: number): Order {
    const o = this.orders.get(id)!;
    o.dormant_since = dormantSince;
    o.follow_up_stage = stage;
    return { ...o };
  }
  getStateEntryTime(_orderId: string, _state: OrderState): string | null { return null; }
  getAllNonTerminalOrders(): Order[] {
    return [...this.orders.values()].filter(o => !["closed", "cancelled", "forfeited"].includes(o.state));
  }
  getDailyMockupSpendCents(_todayIso: string): number { return 0; }
  getLastRejectedAction(_orderId: string): string | null { return null; }
}

// ── Fake providers ───────────────────────────────────────────────────────────
class FakeProvider implements PaymentProvider {
  readonly method = "stripe" as const;
  charges = 0;
  constructor(private result: ChargeResult = { status: "pending" }) {}
  async charge(_a: ChargeArgs): Promise<ChargeResult> { this.charges++; return this.result; }
  async getStatus(): Promise<PaymentStatus> { return this.result.status as PaymentStatus; }
}

/** Mockup pipeline that records the order passed to generate (for element inspection). */
class CapturingMockup implements MockupPipeline {
  calls: Array<{ order: Order; variant: string; brief: string }> = [];
  callCount = 0;
  async generate(order: Order, variant: "A" | "B" | "both", brief: string): Promise<MockupUrls> {
    this.calls.push({ order: { ...order }, variant, brief });
    this.callCount++;
    return { A: `https://cdn.example.com/rev${this.callCount}_A.png`, B: `https://cdn.example.com/rev${this.callCount}_B.png` };
  }
}

const fakeAssetStore = {
  pendingAssets: () => [],
  resolveLogo: () => null,
  resolveAsset: () => null,
  writeAsset: async () => "fake-asset-id",
  confirmAssetRole: () => {},
  resolveAssetMeta: () => null,
  resolvePendingByRef: () => null,
} as unknown as import("../src/store/asset-store.js").AssetStore;

const fakeSupplierCalls: Array<{ order: Order; note: string }> = [];
const fakeSupplier: SupplierQueue = {
  async queueRevision(order, note) { fakeSupplierCalls.push({ order: { ...order }, note }); },
};

const fakeDelivery: Delivery = {
  async deliverFinal(_order) { return { url: "https://cdn.example.com/final_web_rgb.png" }; },
};
const fakeNotifier: Notifier = { async postToPenn() {} };

function makeApplier(
  store: FakeStore,
  payments: PaymentOps,
  mockups: MockupPipeline = new CapturingMockup(),
  supplier: SupplierQueue = fakeSupplier,
): ActionApplier {
  return new ActionApplier({
    store, payments, mockups,
    supplierQueue: supplier,
    delivery: fakeDelivery,
    notifier: fakeNotifier,
    clock: new SeqClock(),
    defaultMethod: "stripe",
    assetStore: fakeAssetStore,
  });
}

// ── Shared fixture: pre-populated order at awaiting_decision ──────────────────
// Simulates an order that has already been through intake → mockup → awaiting_decision.
// job_spec.elements are pre-populated (as if onRequestMockup already ran).
const BANNER_ELEMENTS = buildInitialElementsForProductType("banner_standard");

function makeReadyOrder(
  store: FakeStore,
  opts: { track?: "physical" | "digital"; price?: number } = {},
): Order {
  const price = opts.price ?? 12000;
  const track = opts.track ?? "undecided";
  let o = store.createOrder("client-fork@wa");
  store.patchOrder(o.order_id, {
    client_name: "Alice",
    business_name: "Alice Corp",
    track,
    selected_mockup: null,
    job_spec: JSON.stringify({
      specs: { product_type: "banner_standard", qr_content: "https://alicecorp.com" },
      elements: BANNER_ELEMENTS,
      mockup_urls: { A: "https://cdn.example.com/A.png", B: "https://cdn.example.com/B.png" },
      price_cents: price,
    } satisfies JobSpec),
  });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");
  return store.getOrder(o.order_id)!;
}

// ══════════════════════════════════════════════════════════════════════════════
// PART A — Deposit fork verification
// ══════════════════════════════════════════════════════════════════════════════

await test("Part A: deposit fork — awaiting_decision → deposit_pending on select+physical+payment", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments);

  const o = makeReadyOrder(store);

  const outcome = await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ], "evt-A1");

  const after = store.getOrder(o.order_id)!;
  assert.equal(outcome.rejected.length, 0, `unexpected rejections: ${JSON.stringify(outcome.rejected)}`);
  assert.equal(after.state, "deposit_pending", "order must be in deposit_pending after deposit request");
  assert.equal(after.selected_mockup, "B", "selected_mockup recorded");
  assert.equal(after.track, "physical", "track = physical");

  // Deposit payment row created with correct amount (50% of 12000 = 6000)
  const dep = store.listPayments(o.order_id).find(p => p.kind === "deposit");
  assert.ok(dep, "deposit payment row exists");
  assert.equal(dep!.amount_cents, 6000, "deposit amount = 50% of price");
  assert.equal(dep!.direction, "in", "deposit is inbound");
});

await test("Part A: deposit fork — job_spec.elements populated at deposit_pending", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments);

  const o = makeReadyOrder(store);
  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "A" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ], "evt-A2");

  const after = store.getOrder(o.order_id)!;
  assert.equal(after.state, "deposit_pending");

  const spec = JSON.parse(after.job_spec!) as JobSpec;
  assert.ok(spec.elements && spec.elements.length > 0, "job_spec.elements populated");
  assert.ok(spec.elements!.some(e => e.element_id === "logo_main"), "logo_main element present");
  assert.ok(spec.elements!.some(e => e.element_id === "product_main"), "product_main element present");
  assert.ok(spec.elements!.some(e => e.element_id === "qr_main"), "qr_main element present");
  assert.ok(spec.elements!.some(e => e.element_id === "text_headline"), "text_headline element present");
  // mockup_urls and selected_mockup must also be set
  assert.ok(spec.mockup_urls?.A && spec.mockup_urls?.B, "mockup_urls present");
  assert.equal(after.selected_mockup, "A", "selected_mockup set");
});

await test("Part A: deposit fork — revision transitions to supplier-ready (revision) state", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const supplierCalls: Array<{ order: Order; note: string }> = [];
  const trackingSupplier: SupplierQueue = { async queueRevision(o, n) { supplierCalls.push({ order: { ...o }, note: n }); } };
  const app = makeApplier(store, payments, new CapturingMockup(), trackingSupplier);

  const o = makeReadyOrder(store);
  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ], "evt-A3a");

  // Confirm deposit (simulate Stripe webhook clearance)
  const dep = store.listPayments(o.order_id).find(p => p.kind === "deposit")!;
  store.markPaymentStatus(dep.payment_id, "succeeded", "pi_test_123");

  // Brain sends a revision_note after deposit clears (supplier handoff)
  const revOutcome = await app.applyAll(o.order_id, [
    { type: "revision_note", note: "please proceed with production" },
  ], "evt-A3b");
  assert.equal(revOutcome.rejected.length, 0, `revision_note rejected: ${JSON.stringify(revOutcome.rejected)}`);

  const after = store.getOrder(o.order_id)!;
  assert.equal(after.state, "revision", "order must be in revision (supplier-ready) state");
  assert.equal(supplierCalls.length, 1, "supplier queue called once");
  assert.equal(supplierCalls[0]!.note, "please proceed with production");

  // Verify fulfillment fields accessible (set directly to simulate collection)
  store.patchOrder(o.order_id, {
    fulfillment_method: "ship",
    delivery_address: "123 Main St, Mission, TX 78572",
    shipping_tier: "standard",
    shipping_cents: 1200,
  });
  const withFulfillment = store.getOrder(o.order_id)!;
  assert.equal(withFulfillment.fulfillment_method, "ship");
  assert.ok(withFulfillment.delivery_address?.includes("Mission"), "delivery_address set");
  assert.equal(withFulfillment.shipping_cents, 1200);
});

await test("Part A: deposit fork — job_spec.elements accessible for supplier agent at revision state", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments);

  const o = makeReadyOrder(store);
  await app.applyAll(o.order_id, [
    { type: "set_mockup_selected", which: "A" } as never,  // fallback: patch directly
  ], "evt-A4-pre");
  store.patchOrder(o.order_id, { selected_mockup: "A", track: "physical" });
  store.transition(o.order_id, "deposit_pending");

  // Confirm deposit
  const dep = store.insertPendingPayment({
    order_id: o.order_id, kind: "deposit", direction: "in",
    amount_cents: 6000, currency: "USD", fx_to_usd: 1.0, method: "stripe",
    idempotency_key: `${o.order_id}:deposit:manual`,
  });
  store.markPaymentStatus(dep.payment_id, "succeeded", "pi_manual");

  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "banner looks good, ship it" },
  ], "evt-A4b");

  const after = store.getOrder(o.order_id)!;
  assert.equal(after.state, "revision");

  // Supplier agent fetches job_spec — elements must be present
  const spec = JSON.parse(after.job_spec!) as JobSpec;
  assert.ok(Array.isArray(spec.elements) && spec.elements.length > 0, "job_spec.elements present for supplier fetch");
  assert.ok(spec.specs?.product_type, "product_type in job_spec.specs");
  assert.ok(spec.mockup_urls, "mockup_urls in job_spec");
  assert.equal(after.selected_mockup, "A", "selected_mockup retained");
});

// ══════════════════════════════════════════════════════════════════════════════
// PART B — Digital $5 fork verification
// ══════════════════════════════════════════════════════════════════════════════

await test("Part B: digital fork — awaiting_decision → digital_pending on set_track+request_payment", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments);

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { selected_mockup: "A" });

  const outcome = await app.applyAll(o.order_id, [
    { type: "set_track", track: "digital" },
    { type: "request_payment", kind: "digital" },
  ], "evt-B1");

  const after = store.getOrder(o.order_id)!;
  assert.equal(outcome.rejected.length, 0, JSON.stringify(outcome.rejected));
  assert.equal(after.state, "digital_pending", "order in digital_pending after $5 request");
  assert.equal(after.track, "digital");

  // Digital payment: fixed $5 = 500 cents
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital");
  assert.ok(pay, "digital payment row created");
  assert.equal(pay!.amount_cents, 500, "digital payment = $5 (500 cents)");
});

await test("Part B: digital fork — revision_note applies element directives and calls generate with updated elements", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const capturing = new CapturingMockup();
  const app = makeApplier(store, payments, capturing);

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { selected_mockup: "A", track: "digital" });

  // 1. Request $5 digital
  await app.applyAll(o.order_id, [
    { type: "request_payment", kind: "digital" },
  ], "evt-B2a");

  // 2. Confirm $5 payment (Stripe webhook)
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital")!;
  store.markPaymentStatus(pay.payment_id, "succeeded", "pi_digital_1");

  // 3. Client sends revision: "make logo bigger"
  const revOutcome = await app.applyAll(o.order_id, [
    { type: "revision_note", note: "make the logo bigger" },
  ], "evt-B2b");

  assert.equal(revOutcome.rejected.length, 0, JSON.stringify(revOutcome.rejected));

  const after = store.getOrder(o.order_id)!;
  assert.equal(after.state, "revision", "order in revision after revision_note");
  assert.equal(after.digital_rounds_used, 1, "digital_rounds_used incremented to 1");

  // Verify generate was called once
  assert.equal(capturing.callCount, 1, "generate called once for revision");

  // Verify the order passed to generate has updated elements (logo scaled up by 1.2x)
  const capturedOrder = capturing.calls[0]!.order;
  const capturedSpec = JSON.parse(capturedOrder.job_spec!) as JobSpec;
  const capturedLogo = capturedSpec.elements?.find(e => e.element_id === "logo_main");
  assert.ok(capturedLogo, "logo_main element present in captured generate call");

  const originalLogo = BANNER_ELEMENTS.find(e => e.element_id === "logo_main")!;
  assert.ok(capturedLogo!.size!.width > originalLogo.size!.width, "logo width increased");
  assert.ok(
    Math.abs(capturedLogo!.size!.width / originalLogo.size!.width - 1.2) < 0.001,
    `logo width should be 1.2x original (got ${capturedLogo!.size!.width}, expected ${originalLogo.size!.width * 1.2})`,
  );

  // job_spec.elements in store updated too
  const storeSpec = JSON.parse(after.job_spec!) as JobSpec;
  const storeLogo = storeSpec.elements?.find(e => e.element_id === "logo_main");
  assert.ok(storeLogo!.size!.width > originalLogo.size!.width, "stored logo element also scaled");
});

await test("Part B: digital fork — final_url set and state=closed after digital_complete", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments, new CapturingMockup());

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { selected_mockup: "A", track: "digital" });

  // Request + confirm $5 payment
  await app.applyAll(o.order_id, [
    { type: "request_payment", kind: "digital" },
  ], "evt-B3a");
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital")!;
  store.markPaymentStatus(pay.payment_id, "succeeded", "pi_digital_2");

  // One revision
  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "looks good as is" },
  ], "evt-B3b");

  // Client approves — digital_complete
  const doneOutcome = await app.applyAll(o.order_id, [
    { type: "digital_complete" },
  ], "evt-B3c");

  assert.equal(doneOutcome.rejected.length, 0, JSON.stringify(doneOutcome.rejected));
  const after = store.getOrder(o.order_id)!;
  assert.equal(after.state, "closed", "order closed after digital_complete");

  // final_url must be written to job_spec
  const spec = JSON.parse(after.job_spec!) as JobSpec;
  assert.ok(spec.final_url, "final_url present in job_spec");
  assert.ok(spec.final_url!.startsWith("https://"), "final_url is a valid URL");
});

await test("Part B: digital fork — job_spec.elements present from template before first revision", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments, new CapturingMockup());

  // Order with NO elements pre-set (legacy scenario) — elements initialized lazily
  const o = store.createOrder("legacy-client@wa");
  store.patchOrder(o.order_id, {
    client_name: "Bob", business_name: "Bob LLC", track: "digital",
    selected_mockup: "A",
    job_spec: JSON.stringify({
      specs: { product_type: "banner_standard" },
      mockup_urls: { A: "https://cdn.example.com/A.png", B: "https://cdn.example.com/B.png" },
      price_cents: 500,
      // No elements — simulates pre-element-addressable order
    } satisfies JobSpec),
  });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");

  await app.applyAll(o.order_id, [
    { type: "request_payment", kind: "digital" },
  ], "evt-B4a");
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital")!;
  store.markPaymentStatus(pay.payment_id, "succeeded", "pi_legacy");

  // First revision on legacy order — elements initialized from template
  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "make logo smaller" },
  ], "evt-B4b");

  const after = store.getOrder(o.order_id)!;
  const spec = JSON.parse(after.job_spec!) as JobSpec;
  assert.ok(spec.elements && spec.elements.length > 0, "elements initialized from template on legacy order");
  const logo = spec.elements!.find(e => e.element_id === "logo_main");
  assert.ok(logo, "logo_main initialized");
  // After "make logo smaller" (0.8x), logo width < original
  const originalLogo = BANNER_ELEMENTS.find(e => e.element_id === "logo_main")!;
  assert.ok(logo!.size!.width < originalLogo.size!.width, "logo shrunk (0.8x) after directive");
});

// ══════════════════════════════════════════════════════════════════════════════
// PART C — Integration seams
// ══════════════════════════════════════════════════════════════════════════════

await test("Part C: payment confirm → succeededDigitalBlocks increments → rounds unlock", () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const o = store.createOrder("test@wa");

  assert.equal(store.succeededDigitalBlocks(o.order_id), 0, "0 blocks before payment");

  // Insert and confirm a digital payment
  const p = store.insertPendingPayment({
    order_id: o.order_id, kind: "digital", direction: "in",
    amount_cents: 500, currency: "USD", fx_to_usd: 1.0, method: "stripe",
    idempotency_key: `${o.order_id}:digital:0`,
  });
  assert.equal(store.succeededDigitalBlocks(o.order_id), 0, "still 0 while pending");
  store.markPaymentStatus(p.payment_id, "succeeded", "pi_webhook");
  assert.equal(store.succeededDigitalBlocks(o.order_id), 1, "1 block after confirm");
});

await test("Part C: both forks have access to fulfillment data via patchOrder", () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const o = store.createOrder("test@wa");

  store.patchOrder(o.order_id, {
    fulfillment_method: "local_delivery",
    delivery_address: "456 Oak Ave, McAllen, TX 78501",
    shipping_tier: "standard",
    shipping_cents: 0,
  });
  const after = store.getOrder(o.order_id)!;
  assert.equal(after.fulfillment_method, "local_delivery");
  assert.ok(after.delivery_address?.includes("McAllen"));
  assert.equal(after.shipping_cents, 0);
});

await test("Part C: deposit fork → revision state maintains elements + fulfillment together", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments);

  const o = makeReadyOrder(store, { track: "physical" });

  // Set fulfillment before payment
  store.patchOrder(o.order_id, {
    fulfillment_method: "ship",
    delivery_address: "789 Elm Rd, Edinburg, TX 78539",
    shipping_cents: 1500,
  });

  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "request_payment", kind: "deposit" },
  ], "evt-C3a");

  const dep = store.listPayments(o.order_id).find(p => p.kind === "deposit")!;
  store.markPaymentStatus(dep.payment_id, "succeeded", "pi_c3");

  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "ship it" },
  ], "evt-C3b");

  const after = store.getOrder(o.order_id)!;
  assert.equal(after.state, "revision");
  // Both elements and fulfillment must be readable together
  const spec = JSON.parse(after.job_spec!) as JobSpec;
  assert.ok(spec.elements && spec.elements.length > 0, "elements accessible");
  assert.equal(after.fulfillment_method, "ship", "fulfillment_method accessible");
  assert.equal(after.shipping_cents, 1500, "shipping_cents accessible");
  assert.ok(after.delivery_address, "delivery_address accessible");
});

// ══════════════════════════════════════════════════════════════════════════════
// PART D — Specific scenario tests
// ══════════════════════════════════════════════════════════════════════════════

// D.1 — Deposit fork end-to-end (compact)
await test("Part D: deposit fork e2e — order → mockup → payment → supplier-ready", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const supplierLog: string[] = [];
  const trackSup: SupplierQueue = { async queueRevision(o, n) { supplierLog.push(`${o.order_id}:${n}`); } };
  const app = makeApplier(store, payments, new CapturingMockup(), trackSup);

  const o = makeReadyOrder(store);
  // Full deposit fork action sequence
  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "A" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ], "evt-D1a");

  assert.equal(store.getOrder(o.order_id)!.state, "deposit_pending");

  const dep = store.listPayments(o.order_id).find(p => p.kind === "deposit")!;
  store.markPaymentStatus(dep.payment_id, "succeeded", "pi_d1");

  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "approved, start production" },
  ], "evt-D1b");

  const final = store.getOrder(o.order_id)!;
  assert.equal(final.state, "revision", "supplier-ready: order in revision");
  assert.equal(supplierLog.length, 1, "supplier queue notified");
  const spec = JSON.parse(final.job_spec!) as JobSpec;
  assert.ok(spec.elements!.some(e => e.element_id === "logo_main"), "elements present for supplier");
  assert.ok(spec.mockup_urls?.A || spec.mockup_urls?.B, "mockup_urls present for supplier");
});

// D.2 — Digital fork end-to-end (compact)
await test("Part D: digital fork e2e — order → mockup → $5 → revision delta → final file", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const capturing = new CapturingMockup();
  const app = makeApplier(store, payments, capturing);

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { selected_mockup: "B", track: "digital" });

  // $5 purchase
  await app.applyAll(o.order_id, [
    { type: "request_payment", kind: "digital" },
  ], "evt-D2a");
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital")!;
  store.markPaymentStatus(pay.payment_id, "succeeded", "pi_d2");

  // 1 revision: "make logo bigger"
  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "make logo bigger" },
  ], "evt-D2b");

  // Client approves
  await app.applyAll(o.order_id, [
    { type: "digital_complete" },
  ], "evt-D2c");

  const final = store.getOrder(o.order_id)!;
  assert.equal(final.state, "closed");
  assert.equal(final.digital_rounds_used, 1);
  const spec = JSON.parse(final.job_spec!) as JobSpec;
  assert.ok(spec.final_url, "final_url written to job_spec");
  // Verify revision delta was applied: logo in captured generate call is bigger
  const logo = capturing.calls[0]!.order;
  const logoSpec = JSON.parse(logo.job_spec!) as JobSpec;
  const logoEl = logoSpec.elements?.find(e => e.element_id === "logo_main");
  const original = BANNER_ELEMENTS.find(e => e.element_id === "logo_main")!;
  assert.ok(logoEl!.size!.width > original.size!.width, "logo is bigger in revision render");
});

// D.3 — Revision delta: parseRevisionDirectives + applyElementDirectives pipeline
await test("Part D: revision delta — 'make logo bigger' → 1.2x size override applied in job_spec", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const capturing = new CapturingMockup();
  const app = makeApplier(store, payments, capturing);

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { selected_mockup: "A", track: "digital" });

  await app.applyAll(o.order_id, [{ type: "request_payment", kind: "digital" }], "evt-D3a");
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital")!;
  store.markPaymentStatus(pay.payment_id, "succeeded", "pi_d3");

  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "please make the logo bigger" },
  ], "evt-D3b");

  // Verify stored elements
  const spec = JSON.parse(store.getOrder(o.order_id)!.job_spec!) as JobSpec;
  const logo = spec.elements!.find(e => e.element_id === "logo_main")!;
  const orig = BANNER_ELEMENTS.find(e => e.element_id === "logo_main")!;

  assert.ok(
    Math.abs(logo.size!.width - orig.size!.width * 1.2) < 0.001,
    `logo_main width should be 1.2x original (${orig.size!.width} → ${orig.size!.width * 1.2}), got ${logo.size!.width}`,
  );
  assert.ok(
    Math.abs(logo.size!.height - orig.size!.height * 1.2) < 0.001,
    `logo_main height should be 1.2x original`,
  );

  // Verify generate was called with the updated order
  assert.equal(capturing.callCount, 1, "generate called once");
  const capturedSpec = JSON.parse(capturing.calls[0]!.order.job_spec!) as JobSpec;
  const capturedLogo = capturedSpec.elements!.find(e => e.element_id === "logo_main")!;
  assert.ok(
    Math.abs(capturedLogo.size!.width - orig.size!.width * 1.2) < 0.001,
    "generate received order with updated logo size",
  );
});

// D.4 — Content lock: asset_id and content fields not sourced for rendering
await test("Part D: content lock — asset_id in elements not written back to job_spec from directive", async () => {
  // Structural check: ensure parseRevisionDirectives → applyElementDirectives pipeline
  // does not introduce asset_id/content values that weren't there before.
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments, new CapturingMockup());

  // Setup: elements WITHOUT asset_id (template default — content lock: compositor
  // will always go to AssetStore, never read from element spec)
  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { selected_mockup: "A", track: "digital" });

  await app.applyAll(o.order_id, [{ type: "request_payment", kind: "digital" }], "evt-D4a");
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital")!;
  store.markPaymentStatus(pay.payment_id, "succeeded", "pi_d4");

  await app.applyAll(o.order_id, [
    { type: "revision_note", note: "make logo bigger" },
  ], "evt-D4b");

  const spec = JSON.parse(store.getOrder(o.order_id)!.job_spec!) as JobSpec;
  const logo = spec.elements!.find(e => e.element_id === "logo_main")!;
  const text = spec.elements!.find(e => e.element_id === "text_headline")!;

  // logo element must not have content or asset_id injected by the directive pipeline
  // (these should be absent; the compositor always uses AssetStore for images)
  assert.equal(logo.asset_id, undefined, "logo_main.asset_id absent (compositor uses AssetStore)");
  assert.equal(logo.content, undefined, "logo_main.content absent (compositor uses AssetStore)");
  // text element must not have content sourced from elements (compositor uses Order row)
  assert.equal(text.content, undefined, "text_headline.content absent (compositor uses Order.business_name)");
});

// D.5 — Rounds math: 1 $5 block = 3 rounds; correct consumption and rejection
await test("Part D: rounds math — 1 block = 3 rounds; 1 used = 2 available", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments, new CapturingMockup());

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { selected_mockup: "A", track: "digital" });

  // Purchase 1 block ($5)
  await app.applyAll(o.order_id, [{ type: "request_payment", kind: "digital" }], "evt-D5a");
  const pay = store.listPayments(o.order_id).find(p => p.kind === "digital")!;
  store.markPaymentStatus(pay.payment_id, "succeeded", "pi_d5");

  // Round 1: succeeds
  const r1 = await app.applyAll(o.order_id, [{ type: "revision_note", note: "make logo bigger" }], "evt-D5b");
  assert.equal(r1.rejected.length, 0, "round 1 must succeed");
  assert.equal(store.getOrder(o.order_id)!.digital_rounds_used, 1);

  // Round 2: succeeds
  const r2 = await app.applyAll(o.order_id, [{ type: "revision_note", note: "make logo smaller" }], "evt-D5c");
  assert.equal(r2.rejected.length, 0, "round 2 must succeed");
  assert.equal(store.getOrder(o.order_id)!.digital_rounds_used, 2);

  // Round 3: succeeds (last free round in block)
  const r3 = await app.applyAll(o.order_id, [{ type: "revision_note", note: "change color to blue" }], "evt-D5d");
  assert.equal(r3.rejected.length, 0, "round 3 must succeed");
  assert.equal(store.getOrder(o.order_id)!.digital_rounds_used, 3);

  // Round 4: REJECTED — all 3 rounds in block used
  const r4 = await app.applyAll(o.order_id, [{ type: "revision_note", note: "one more change please" }], "evt-D5e");
  assert.equal(r4.rejected.length, 1, "round 4 must be rejected (0 rounds remaining)");
  assert.ok(r4.rejected[0]!.reason.includes("no revision rounds"), `expected 'no revision rounds', got: ${r4.rejected[0]!.reason}`);
  // digital_rounds_used must NOT increment on rejected revision
  assert.equal(store.getOrder(o.order_id)!.digital_rounds_used, 3, "rounds_used not incremented on rejection");
});

await test("Part D: rounds math — succeededDigitalBlocks=0 → revision_note rejected immediately", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = makeApplier(store, payments, new CapturingMockup());

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { track: "digital" });
  // Force to digital_pending without confirming payment
  store.transition(o.order_id, "digital_pending");

  // No succeeded digital payment → 0 blocks → 0 rounds
  const outcome = await app.applyAll(o.order_id, [
    { type: "revision_note", note: "make logo bigger" },
  ], "evt-D5f");

  assert.equal(outcome.rejected.length, 1, "revision rejected when no digital blocks succeeded");
  assert.ok(outcome.rejected[0]!.reason.includes("no revision rounds"), `got: ${outcome.rejected[0]!.reason}`);
});

// D.6 — No regressions: Stripe idempotency unchanged for deposit
await test("Part D: no regression — deposit idempotency: retry does not double-charge", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const provider = new FakeProvider({ status: "pending" });
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const app = makeApplier(store, payments);

  const o = makeReadyOrder(store, { track: "physical" });

  const first = await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "A" },
    { type: "request_payment", kind: "deposit" },
  ], "evt-D6a");

  // Retry the same payment request (e.g., brain re-emitted)
  const retry = await app.applyAll(o.order_id, [
    { type: "request_payment", kind: "deposit" },
  ], "evt-D6b");

  // One of these is rejected because deposit is already in-flight
  const total = first.rejected.length + retry.rejected.length;
  assert.equal(total >= 1, true, "at least one retry rejected (deposit already pending)");
  assert.equal(provider.charges, 1, "charge fires exactly once regardless of retries");
  assert.equal(store.listPayments(o.order_id).filter(p => p.kind === "deposit").length, 1, "single deposit row");
});

await test("Part D: no regression — digital idempotency: $5 retry does not double-charge", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const provider = new FakeProvider({ status: "pending" });
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const app = makeApplier(store, payments, new CapturingMockup());

  const o = makeReadyOrder(store);
  store.patchOrder(o.order_id, { track: "digital" });

  await app.applyAll(o.order_id, [{ type: "request_payment", kind: "digital" }], "evt-D7a");
  // Retry from same state
  const retry = await app.applyAll(o.order_id, [{ type: "request_payment", kind: "digital" }], "evt-D7b");

  // With digital_pending, second request_payment is rejected (pending already in flight)
  assert.equal(provider.charges, 1, "digital charge fires once only");
  assert.equal(retry.rejected.length, 1, "second request_payment rejected (already pending)");
});

await test("Part D: no regression — failed deposit charge does not strand order", async () => {
  const clock = new SeqClock(); const store = new FakeStore(clock, new SeqId());
  const provider = new FakeProvider({ status: "failed", error: "stripe transient" });
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const app = makeApplier(store, payments);

  const o = makeReadyOrder(store, { track: "physical" });
  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "request_payment", kind: "deposit" },
  ], "evt-D8a");

  const after = store.getOrder(o.order_id)!;
  assert.equal(after.state, "awaiting_decision", "state stays at awaiting_decision on failed charge");
  assert.equal(store.hasHeldMoney(o.order_id), false, "no money held on failure");
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
