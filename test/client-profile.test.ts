// test/client-profile.test.ts
// Exercises the client-profile feature: schema methods, onCollect upsert,
// returning-client recognition, and retrieve_past_job recall.
// Runs under tsx with NO external deps: `npx tsx test/client-profile.test.ts`.

import assert from "node:assert";

import {
  Order,
  OrderState,
  Payment,
  PaymentStatus,
  EventRow,
  ClientPaymentKind,
  Client,
} from "../src/domain/types.js";
import { Store, NewEvent, NewPayment, Quote, IdempotencyCollision } from "../src/store/store.js";
import { Clock, IdGen } from "../src/domain/ports.js";
import { assertTransition } from "../src/domain/state-machine.js";
import { ActionApplier } from "../src/brain/action-applier.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { PaymentProvider, ChargeArgs, ChargeResult, usdOnlyFx } from "../src/payments/providers.js";
import { MockupPipeline, SupplierQueue, Delivery, Notifier, MockupUrls } from "../src/domain/integrations.js";

// ── tiny test harness ─────────────────────────────────────────────────────
let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ── deterministic clock + ids ──────────────────────────────────────────────
class SeqClock implements Clock {
  private t = 1_800_000_000_000;
  nowIso() { return new Date((this.t += 1000)).toISOString(); }
  nowMs() { return this.t; }
}
class SeqId implements IdGen {
  private n = 0;
  next() { return `id-${++this.n}`; }
}

// ── in-memory Store (client-profile subset) ────────────────────────────────
class FakeStore implements Store {
  orders = new Map<string, Order>();
  payments: Payment[] = [];
  events: EventRow[] = [];
  quotes: Quote[] = [];
  clients = new Map<string, Client>();
  constructor(private clock: Clock, private ids: IdGen) {}

  createOrder(jid: string): Order {
    const now = this.clock.nowIso();
    const o: Order = {
      order_id: this.ids.next(),
      created_at: now,
      updated_at: now,
      whatsapp_jid: jid,
      client_name: null,
      business_name: null,
      project_type: null,
      job_spec: null,
      track: "undecided",
      selected_mockup: null,
      state: "intake",
      dormant_since: null,
      follow_up_stage: 0,
      escalation: null,
      dispute_flag: 0,
      failed_mockup_pairs: 0,
      digital_rounds_used: 0,
      assigned_supplier_id: null,
      hermes_session_id: null,
      turn_count: 0,
      last_tier: null,
      force_tier: null,
      notes: null,
      fulfillment_method: null,
      delivery_address: null,
      shipping_tier: null,
      shipping_cents: null,
      ready_to_ship_date: null,
    };
    this.orders.set(o.order_id, o);
    return { ...o };
  }
  getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? { ...o } : null;
  }
  findActiveOrderByJid(jid: string): Order | null {
    const TERMINAL: OrderState[] = ["closed", "cancelled", "forfeited"];
    const list = [...this.orders.values()].filter(
      (o) => o.whatsapp_jid === jid && !TERMINAL.includes(o.state as OrderState),
    );
    return list.length ? { ...list[list.length - 1]! } : null;
  }
  patchOrder(id: string, patch: Partial<Order>): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error("no order");
    Object.assign(o, patch, { updated_at: this.clock.nowIso() });
    return { ...o };
  }
  transition(id: string, to: OrderState, payload?: unknown): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error("no order");
    assertTransition(o.state, to);
    o.state = to;
    o.updated_at = this.clock.nowIso();
    void payload;
    return { ...o };
  }

  // ── client profile ──────────────────────────────────────────────────────
  addOrUpdateClient(jid: string, name?: string | null, business?: string | null, delivery_address?: string | null): Client {
    const now = this.clock.nowIso();
    const existing = this.clients.get(jid);
    if (existing) {
      if (name !== undefined) existing.name = name ?? undefined;
      if (business !== undefined) existing.business = business ?? undefined;
      if (delivery_address !== undefined) existing.delivery_address = delivery_address ?? undefined;
      existing.updated_at = now;
      return { ...existing };
    }
    const c: Client = {
      client_id: this.ids.next(),
      whatsapp_jid: jid,
      name: name ?? undefined,
      business: business ?? undefined,
      delivery_address: delivery_address ?? undefined,
      created_at: now,
      updated_at: now,
    };
    this.clients.set(jid, c);
    return { ...c };
  }
  getClientByJid(jid: string): Client | null {
    const c = this.clients.get(jid);
    return c ? { ...c } : null;
  }
  getClientOrders(jid: string): Order[] {
    return [...this.orders.values()].filter((o) => o.whatsapp_jid === jid).map((o) => ({ ...o }));
  }

  // ── payments (stubs) ───────────────────────────────────────────────────
  insertPendingPayment(p: NewPayment): Payment {
    if (this.payments.some((x) => x.idempotency_key === p.idempotency_key)) {
      throw new IdempotencyCollision(p.idempotency_key);
    }
    const row: Payment = { payment_id: this.ids.next(), created_at: this.clock.nowIso(), status: "pending", external_ref: null, ...p };
    this.payments.push(row);
    return { ...row };
  }
  getPaymentByKey(key: string) { return this.payments.find((x) => x.idempotency_key === key) ?? null; }
  getPayment(id: string) { return this.payments.find((x) => x.payment_id === id) ?? null; }
  markPaymentStatus(id: string, status: PaymentStatus, ref?: string | null): Payment {
    const p = this.payments.find((x) => x.payment_id === id)!;
    p.status = status;
    if (ref !== undefined) p.external_ref = ref;
    return { ...p };
  }
  markPaymentStatusIfPending(id: string, status: PaymentStatus, ref?: string | null) {
    const p = this.payments.find((x) => x.payment_id === id);
    if (!p || p.status !== "pending") return { changes: 0, payment: p ? { ...p } : null };
    p.status = status;
    if (ref !== undefined) p.external_ref = ref;
    return { changes: 1, payment: { ...p } };
  }
  listPayments(orderId: string) { return this.payments.filter((x) => x.order_id === orderId).map((x) => ({ ...x })); }
  pendingClientPaymentKind(orderId: string): ClientPaymentKind | "none" {
    const p = this.payments.find((x) => x.order_id === orderId && x.direction === "in" && x.status === "pending" && ["deposit","balance","digital"].includes(x.kind));
    return (p?.kind as ClientPaymentKind) ?? "none";
  }
  hasHeldMoney(orderId: string) { return this.payments.some((x) => x.order_id === orderId && x.direction === "in" && x.status === "succeeded"); }
  succeededDigitalBlocks(orderId: string) { return this.payments.filter((x) => x.order_id === orderId && x.kind === "digital" && x.direction === "in" && x.status === "succeeded").length; }
  succeededRevisionBlocks(orderId: string) { return this.payments.filter((x) => x.order_id === orderId && x.kind === "revision" && x.direction === "in" && x.status === "succeeded").length; }

  // ── events ─────────────────────────────────────────────────────────────
  appendEvent(e: NewEvent): EventRow {
    const row: EventRow = {
      event_id: this.ids.next(),
      order_id: e.order_id,
      created_at: this.clock.nowIso(),
      actor: e.actor,
      type: e.type,
      payload: e.payload === undefined ? null : JSON.stringify(e.payload),
      inbound_event_id: e.inbound_event_id ?? null,
    };
    this.events.push(row);
    return { ...row };
  }
  getEvent(id: string) { return this.events.find((e) => e.event_id === id) ?? null; }
  findUnansweredInbound() { return this.events.filter((ev) => ev.type === "msg_recv" && !this.events.some((r) => r.type === "msg_sent" && r.inbound_event_id === ev.event_id)); }
  findPendingPaymentsWithExternalRef() { return this.payments.filter((p) => p.status === "pending" && p.external_ref); }
  findOrphanedPendingPayments() { return this.payments.filter((p) => p.status === "pending" && !p.external_ref && p.direction === "in"); }
  inboundHasReply(id: string) { return this.events.some((r) => r.type === "msg_sent" && r.inbound_event_id === id); }
  getConversationHistory() { return []; }
  getSelectedQuote(orderId: string) { return this.quotes.find((q) => q.order_id === orderId && q.status === "selected") ?? null; }
  listPendingManualPayments() { return []; }
  getLastClientMessageTime() { return null; }
  findQuietOrders() { return []; }
  setDormancy(id: string, dormantSince: string | null, stage: number): Order {
    const o = this.orders.get(id)!;
    o.dormant_since = dormantSince;
    o.follow_up_stage = stage;
    return { ...o };
  }
  getStateEntryTime() { return null; }
  getAllNonTerminalOrders() { return [...this.orders.values()].map((o) => ({ ...o })); }
  getDailyMockupSpendCents() { return 0; }
  getLastRejectedAction() { return null; }
  close() {}
}

// ── fakes ─────────────────────────────────────────────────────────────────
class FakeProvider implements PaymentProvider {
  readonly method = "stripe" as const;
  async charge(_a: ChargeArgs): Promise<ChargeResult> { return { status: "pending" }; }
}
const fakeMockups: MockupPipeline = { async generate(): Promise<MockupUrls> { return { A: "a.png", B: "b.png" }; } };
const fakeAssetStore = {
  pendingAssets: () => [],
  resolveLogo: () => null,
  resolveAsset: () => null,
  writeAsset: async () => "fake-asset-id",
  confirmAssetRole: () => {},
  resolveAssetMeta: () => null,
  resolvePendingByRef: () => null,
} as unknown as import("../src/store/asset-store.js").AssetStore;
const fakeSupplier: SupplierQueue = { async queueRevision() {} };
const fakeDelivery: Delivery = { async deliverFinal() { return { url: "final.pdf" }; } };
const fakeNotifier: Notifier = { async postToPenn() {} };

function makeApplier(store: FakeStore): ActionApplier {
  const clock = new SeqClock();
  const payments = new PaymentOps(store, new FakeProvider(), usdOnlyFx, clock);
  return new ActionApplier({
    store,
    payments,
    mockups: fakeMockups,
    supplierQueue: fakeSupplier,
    delivery: fakeDelivery,
    notifier: fakeNotifier,
    clock,
    defaultMethod: "stripe",
    assetStore: fakeAssetStore,
  });
}

// ── PART A + B: store method tests ────────────────────────────────────────

test("addOrUpdateClient: new client created with all fields", () => {
  const store = new FakeStore(new SeqClock(), new SeqId());
  const c = store.addOrUpdateClient("alice@wa", "Alice Smith", "Acme Corp", "123 Main St");
  assert.equal(c.whatsapp_jid, "alice@wa");
  assert.equal(c.name, "Alice Smith");
  assert.equal(c.business, "Acme Corp");
  assert.equal(c.delivery_address, "123 Main St");
  assert.ok(c.client_id, "client_id must be set");
  assert.ok(c.created_at, "created_at must be set");
});

test("addOrUpdateClient: existing client updated (name, business, address)", () => {
  const store = new FakeStore(new SeqClock(), new SeqId());
  store.addOrUpdateClient("bob@wa", "Bob", "OldBiz", "Old Address");
  const updated = store.addOrUpdateClient("bob@wa", "Bobby", "NewBiz", "New Address");
  assert.equal(updated.name, "Bobby");
  assert.equal(updated.business, "NewBiz");
  assert.equal(updated.delivery_address, "New Address");
});

test("addOrUpdateClient: partial update — only passed fields change", () => {
  const store = new FakeStore(new SeqClock(), new SeqId());
  store.addOrUpdateClient("carol@wa", "Carol", "BizA", "Addr1");
  // Update only name — address and business must be untouched
  const updated = store.addOrUpdateClient("carol@wa", "Caroline");
  assert.equal(updated.name, "Caroline");
  assert.equal(updated.business, "BizA", "business must be unchanged");
  assert.equal(updated.delivery_address, "Addr1", "address must be unchanged");
});

test("getClientByJid: returns client if exists, null if not", () => {
  const store = new FakeStore(new SeqClock(), new SeqId());
  assert.equal(store.getClientByJid("unknown@wa"), null, "unknown JID must return null");
  store.addOrUpdateClient("dana@wa", "Dana");
  const c = store.getClientByJid("dana@wa");
  assert.ok(c, "known JID must return a Client");
  assert.equal(c!.name, "Dana");
});

test("getClientOrders: returns all orders for JID across all states", () => {
  const store = new FakeStore(new SeqClock(), new SeqId());
  const o1 = store.createOrder("eve@wa");
  const o2 = store.createOrder("eve@wa");
  store.createOrder("other@wa"); // different JID — must not appear
  const orders = store.getClientOrders("eve@wa");
  assert.equal(orders.length, 2);
  const ids = orders.map((o) => o.order_id);
  assert.ok(ids.includes(o1.order_id));
  assert.ok(ids.includes(o2.order_id));
});

// ── PART C: onCollect integration ─────────────────────────────────────────

test("onCollect: calls addOrUpdateClient with collected client_name and business_name", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const applier = makeApplier(store);
  const o = store.createOrder("frank@wa");

  await applier.applyAll(o.order_id, [
    { type: "collect", fields: { client_name: "Frank Lee", business_name: "Frank's Print Co" } },
  ], "evt-1");

  const client = store.getClientByJid("frank@wa");
  assert.ok(client, "client record must exist after onCollect");
  assert.equal(client!.name, "Frank Lee");
  assert.equal(client!.business, "Frank's Print Co");
});

test("onCollect: address only updates client profile when delivery_address is explicitly collected", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const applier = makeApplier(store);
  const o = store.createOrder("grace@wa");

  // First collect with name only — address must NOT create a client address entry
  await applier.applyAll(o.order_id, [
    { type: "collect", fields: { client_name: "Grace" } },
  ], "evt-1");
  const before = store.getClientByJid("grace@wa");
  assert.equal(before?.delivery_address, undefined, "address must be undefined before collection");

  // Second collect with address — now it should update
  await applier.applyAll(o.order_id, [
    { type: "collect", fields: { delivery_address: "500 Oak Ave" } },
  ], "evt-2");
  const after = store.getClientByJid("grace@wa");
  assert.equal(after?.delivery_address, "500 Oak Ave");
});

// ── PART C: returning client recognition ──────────────────────────────────

test("recognizeReturningClient: returns client record for known JID, null for unknown", () => {
  const store = new FakeStore(new SeqClock(), new SeqId());
  const applier = makeApplier(store);

  assert.equal(applier.recognizeReturningClient("new@wa"), null, "unknown JID must return null");

  store.addOrUpdateClient("repeat@wa", "Repeat Client", "RC Biz");
  const client = applier.recognizeReturningClient("repeat@wa");
  assert.ok(client, "known JID must return Client record");
  assert.equal(client!.name, "Repeat Client");
  assert.equal(client!.business, "RC Biz");
  assert.equal(client!.whatsapp_jid, "repeat@wa");
});

// ── PART D: retrieve_past_job ─────────────────────────────────────────────

test("retrievePastJob: surfaces recalled order spec and validates JID ownership", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const applier = makeApplier(store);
  const jid = "henry@wa";

  // Past order for this client
  const pastOrder = store.createOrder(jid);
  store.patchOrder(pastOrder.order_id, {
    selected_mockup: "A",
    job_spec: JSON.stringify({ price_cents: 15000, mockup_urls: { A: "mock-a.png", B: "mock-b.png" } }),
  });

  // Current order for the same client
  const currentOrder = store.createOrder(jid);

  const outcome = await applier.applyAll(currentOrder.order_id, [
    { type: "retrieve_past_job", order_id: pastOrder.order_id },
  ], "evt-1");

  assert.equal(outcome.rejected.length, 0, "retrieve_past_job must not be rejected for same-JID order");

  const updated = store.getOrder(currentOrder.order_id)!;
  const spec = JSON.parse(updated.job_spec!);
  assert.ok(spec.recalled_job, "recalled_job must be in job_spec");
  assert.equal(spec.recalled_job.order_id, pastOrder.order_id);
  assert.equal(spec.recalled_job.selected_mockup, "A");
  assert.equal(spec.recalled_job.price_cents, 15000);
  assert.deepEqual(spec.recalled_job.mockup_urls, { A: "mock-a.png", B: "mock-b.png" });
});

test("retrievePastJob: rejected when target order belongs to different client", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const applier = makeApplier(store);

  const otherOrder = store.createOrder("other@wa");
  const myOrder = store.createOrder("me@wa");

  const outcome = await applier.applyAll(myOrder.order_id, [
    { type: "retrieve_past_job", order_id: otherOrder.order_id },
  ], "evt-1");

  assert.equal(outcome.rejected.length, 1, "cross-client recall must be rejected");
  assert.ok(
    outcome.rejected[0]!.reason.includes("different client"),
    `rejection reason should mention 'different client', got: ${outcome.rejected[0]!.reason}`,
  );
});

// ── run ───────────────────────────────────────────────────────────────────

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
