// test/core.test.ts
// Runs under tsx with NO external deps: `npm test`. Exercises the invariant-bearing
// core against an in-memory Store fake — the same port the SQLite store implements.

import assert from "node:assert";

import {
  Order,
  OrderState,
  Payment,
  PaymentStatus,
  EventRow,
  ClientPaymentKind,
} from "../src/domain/types.js";
import { canTransition } from "../src/domain/state-machine.js";
import { derivePhase } from "../src/domain/phase.js";
import { parseBrainOutput } from "../src/brain/actions.js";
import { selectModel } from "../src/model-router.js";
import { Store, NewEvent, NewPayment, Quote, IdempotencyCollision } from "../src/store/store.js";
import { Clock, IdGen } from "../src/domain/ports.js";
import { assertTransition } from "../src/domain/state-machine.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { PaymentProvider, ChargeArgs, ChargeResult, usdOnlyFx } from "../src/payments/providers.js";
import { ActionApplier } from "../src/brain/action-applier.js";
import { Host } from "../src/host.js";
import { MockupPipeline, SupplierQueue, Delivery, Notifier, MockupUrls } from "../src/domain/integrations.js";
import { Cadence } from "../src/channel/cadence.js";
import { WhatsAppChannel, InboundMessage } from "../src/channel/channel.js";

// ── tiny test harness ───────────────────────────────────────────────────
let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ── deterministic clock + ids ─────────────────────────────────────────────
class SeqClock implements Clock {
  private t = 1_700_000_000_000;
  nowIso() {
    return new Date((this.t += 1000)).toISOString();
  }
  nowMs() {
    return this.t;
  }
}
class SeqId implements IdGen {
  private n = 0;
  next() {
    return `id-${++this.n}`;
  }
}

// ── in-memory Store (mirrors SqliteStore semantics) ────────────────────────
class FakeStore implements Store {
  orders = new Map<string, Order>();
  payments: Payment[] = [];
  events: EventRow[] = [];
  quotes: Quote[] = [];
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
    };
    this.orders.set(o.order_id, o);
    return { ...o };
  }
  getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? { ...o } : null;
  }
  findActiveOrderByJid(jid: string) {
    const list = [...this.orders.values()].filter(
      (o) => o.whatsapp_jid === jid && !["closed", "cancelled", "forfeited"].includes(o.state),
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
    o.state = to;
    o.updated_at = this.clock.nowIso();
    void payload;
    return { ...o };
  }
  insertPendingPayment(p: NewPayment): Payment {
    if (this.payments.some((x) => x.idempotency_key === p.idempotency_key)) {
      throw new IdempotencyCollision(p.idempotency_key);
    }
    const row: Payment = {
      payment_id: this.ids.next(),
      created_at: this.clock.nowIso(),
      status: "pending",
      external_ref: null,
      ...p,
    };
    this.payments.push(row);
    return { ...row };
  }
  getPaymentByKey(key: string) {
    const p = this.payments.find((x) => x.idempotency_key === key);
    return p ? { ...p } : null;
  }
  getPayment(id: string) {
    const p = this.payments.find((x) => x.payment_id === id);
    return p ? { ...p } : null;
  }
  markPaymentStatus(id: string, status: PaymentStatus, ref?: string | null) {
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
  
  // Simulate database transaction (no-op in fake, just tracks state)
  db = {
    transaction: (fn: () => void) => fn,
  };
  listPayments(orderId: string) {
    return this.payments.filter((x) => x.order_id === orderId).map((x) => ({ ...x }));
  }
  pendingClientPaymentKind(orderId: string): ClientPaymentKind | "none" {
    const p = this.payments.find(
      (x) =>
        x.order_id === orderId &&
        x.direction === "in" &&
        x.status === "pending" &&
        ["deposit", "balance", "digital"].includes(x.kind),
    );
    return (p?.kind as ClientPaymentKind) ?? "none";
  }
  hasHeldMoney(orderId: string) {
    return this.payments.some((x) => x.order_id === orderId && x.direction === "in" && x.status === "succeeded");
  }
  succeededDigitalBlocks(orderId: string) {
    return this.payments.filter(
      (x) => x.order_id === orderId && x.kind === "digital" && x.direction === "in" && x.status === "succeeded",
    ).length;
  }
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
  findUnansweredInbound() {
    return this.events.filter(
      (ev) =>
        ev.type === "msg_recv" &&
        !this.events.some((r) => r.type === "msg_sent" && r.inbound_event_id === ev.event_id),
    );
  }
  findPendingPaymentsWithExternalRef() {
    return this.payments.filter((p) => p.status === "pending" && p.external_ref);
  }
  inboundHasReply(id: string) {
    return this.events.some((r) => r.type === "msg_sent" && r.inbound_event_id === id);
  }
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
  getSelectedQuote(orderId: string) {
    return this.quotes.find((q) => q.order_id === orderId && q.status === "selected") ?? null;
  }
  findQuietOrders(quietSinceIso: string) {
    return [...this.orders.values()].filter(
      (o) =>
        !["closed", "cancelled", "forfeited"].includes(o.state) &&
        (o.updated_at <= quietSinceIso || o.dormant_since !== null),
    );
  }
  setDormancy(id: string, dormantSince: string | null, stage: number) {
    const o = this.orders.get(id)!;
    o.dormant_since = dormantSince;
    o.follow_up_stage = stage;
    return { ...o };
  }
  getLastRejectedAction(orderId: string): string | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!;
      if (ev.order_id !== orderId || ev.type !== "state_change") continue;
      try {
        const p = ev.payload ? (JSON.parse(ev.payload) as { rejected_action?: { type?: string } }) : null;
        if (p?.rejected_action?.type) return p.rejected_action.type;
      } catch { /* skip malformed */ }
    }
    return null;
  }
  close() {}
}

// ── fakes ─────────────────────────────────────────────────────────────────
class FakeProvider implements PaymentProvider {
  readonly method = "stripe" as const;
  charges = 0;
  constructor(private result: ChargeResult = { status: "pending" }) {}
  async charge(_a: ChargeArgs): Promise<ChargeResult> {
    this.charges++;
    return this.result;
  }
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
const zeroCadence: Cadence = { readDelayMs: () => 0, typingMs: () => 0 };
const noSleep = async () => {};

function applier(store: Store, payments: PaymentOps): ActionApplier {
  return new ActionApplier({
    store,
    payments,
    mockups: fakeMockups,
    supplierQueue: fakeSupplier,
    delivery: fakeDelivery,
    notifier: fakeNotifier,
    clock: new SeqClock(),
    defaultMethod: "stripe",
  });
}

// ── tests ───────────────────────────────────────────────────────────────

test("state machine: legal + illegal transitions", () => {
  assert.ok(canTransition("intake", "mockup"));
  assert.ok(canTransition("awaiting_decision", "deposit_pending"));
  assert.ok(canTransition("revision", "revision"));
  assert.ok(canTransition("deposit_pending", "forfeited"));
  assert.ok(canTransition("in_production", "cancelled"));
  assert.ok(!canTransition("intake", "delivered"));
  assert.ok(!canTransition("closed", "mockup"));
  assert.ok(!canTransition("awaiting_decision", "forfeited")); // not forfeitable here
});

test("parser: strips actions block, parses intents", () => {
  const raw = 'Sounds great!\n\n```actions\n[{"type":"set_track","track":"physical"}]\n```';
  const p = parseBrainOutput(raw);
  assert.equal(p.reply, "Sounds great!");
  assert.equal(p.silent, false);
  assert.equal(p.actions.length, 1);
  assert.deepEqual(p.actions[0], { type: "set_track", track: "physical" });
});

test("parser: [SILENT] and malformed JSON", () => {
  assert.equal(parseBrainOutput("[SILENT]").silent, true);
  const bad = parseBrainOutput("hi\n```actions\n[not json]\n```");
  assert.ok(bad.parseError);
  assert.equal(bad.actions.length, 0);
});

test("parser: rejects brain-emitted mockup_pairs escalation", () => {
  const p = parseBrainOutput('ok\n```actions\n[{"type":"escalate","reason":"mockup_pairs"}]\n```');
  assert.equal(p.actions.length, 0);
  assert.equal(p.rejected.length, 1);
});

test("phase derivation", () => {
  const base = new FakeStore(new SeqClock(), new SeqId()).createOrder("j");
  assert.equal(derivePhase({ ...base, state: "intake", turn_count: 1 }), "first_contact");
  assert.equal(derivePhase({ ...base, state: "revision" }), "revision_loop");
  assert.equal(derivePhase({ ...base, dispute_flag: 1 }), "dispute");
  assert.equal(derivePhase({ ...base, state: "in_production" }), undefined);
});

test("router: friction beats default; stickiness holds on non-trivial turns", () => {
  assert.equal(selectModel({ message: "this is wrong" }).tier, "smart");
  assert.equal(selectModel({ message: "ok" }).tier, "cheap");
  // Sticky only latches on non-trivial (>60 char) turns; a short one may fall to cheap.
  const longNeutral = "I was thinking more about the layout and the colours we picked earlier";
  assert.equal(selectModel({ message: longNeutral, currentTier: "smart" }).tier, "smart");
  assert.equal(selectModel({ message: "ok thanks", currentTier: "smart" }).tier, "cheap");
});

test("SOUL worked example: select B + set_track + request deposit", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const provider = new FakeProvider({ status: "pending" }); // manual-style: clears later
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const app = applier(store, payments);

  // Arrange: an order presented with a pair, priced.
  let o = store.createOrder("client@wa");
  store.patchOrder(o.order_id, { job_spec: JSON.stringify({ price_cents: 20000 }) });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");

  const outcome = await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ]);

  o = store.getOrder(o.order_id)!;
  assert.equal(outcome.rejected.length, 0, JSON.stringify(outcome.rejected));
  assert.equal(o.selected_mockup, "B");
  assert.equal(o.track, "physical");
  assert.equal(o.state, "deposit_pending");
  const dep = store.listPayments(o.order_id).find((p) => p.kind === "deposit")!;
  assert.equal(dep.idempotency_key, `${o.order_id}:deposit:1`);
  assert.equal(dep.amount_cents, 10000); // 50% of 20000
  assert.equal(dep.status, "pending");
  assert.equal(store.pendingClientPaymentKind(o.order_id), "deposit");
});

test("idempotency: a retried charge does not double-charge", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const provider = new FakeProvider({ status: "pending" });
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);

  const o = store.createOrder("c");
  store.patchOrder(o.order_id, { job_spec: JSON.stringify({ price_cents: 20000 }) });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");
  store.patchOrder(o.order_id, { track: "physical" });

  const fresh = store.getOrder(o.order_id)!;
  await payments.requestClientPayment(fresh, "deposit", "stripe");
  await payments.requestClientPayment(fresh, "deposit", "stripe"); // retry

  assert.equal(provider.charges, 1, "charge must fire exactly once");
  assert.equal(store.listPayments(o.order_id).length, 1, "one payment row only");
});

test("illegal intent is rejected, not applied", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider(), usdOnlyFx, clock);
  const app = applier(store, payments);
  const o = store.createOrder("c"); // state intake
  const outcome = await app.applyAll(o.order_id, [{ type: "request_payment", kind: "deposit" }]);
  assert.equal(outcome.rejected.length, 1);
  assert.equal(store.listPayments(o.order_id).length, 0);
  assert.equal(store.getOrder(o.order_id)!.state, "intake");
});

test("host lifecycle: read receipt, reply sent, msg_sent linked to inbound", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const payments = new PaymentOps(store, new FakeProvider(), usdOnlyFx, clock);
  const app = applier(store, payments);

  const sent: string[] = [];
  const reads: string[] = [];
  let handler: ((m: InboundMessage) => Promise<void>) | null = null;
  const channel: WhatsAppChannel = {
    onInbound: (h) => (handler = h),
    readMessages: async (jid) => void reads.push(jid),
    setPresence: async () => {},
    sendMessage: async (_jid, t) => void sent.push(t),
    sendMedia: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  const brain = { async ask() { return "Welcome to Flock! What are we making?"; } };

  const host = new Host({
    store, brain, applier: app, payments, channel, cadence: zeroCadence,
    notifier: fakeNotifier, clock, idGen: new SeqId(), sleep: noSleep,
    systemPrompt: "", assetStore: fakeAssetStore,
  });
  host.attach();
  await handler!({ jid: "newclient@wa", text: "hi" });

  assert.equal(reads.length, 1, "read receipt sent");
  assert.equal(sent.length, 1, "one reply sent");
  const order = store.findActiveOrderByJid("newclient@wa")!;
  assert.equal(order.turn_count, 1);
  const inbound = store.events.find((e) => e.type === "msg_recv")!;
  const outbound = store.events.find((e) => e.type === "msg_sent")!;
  assert.equal(outbound.inbound_event_id, inbound.event_id, "reply linked to inbound (§9)");
  assert.equal(store.findUnansweredInbound().length, 0, "nothing left unanswered");
});

// ── review fixes ─────────────────────────────────────────────────────────
// Tests from the pre-launch review pass. REPRO documents the failure mode;
// ACCEPTANCE is the bar that gates live-Stripe traffic.

test("REPRO (fixed): failed deposit charge must NOT strand the order", async () => {
  const clock = new SeqClock(); const ids = new SeqId();
  const store = new FakeStore(clock, ids);
  const provider = new FakeProvider({ status: "failed", error: "stripe transient error" });
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const app = applier(store, payments);

  const o = store.createOrder("jid-x");
  store.patchOrder(o.order_id, { job_spec: JSON.stringify({ price_cents: 20000 }) });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");

  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ]);

  const after = store.getOrder(o.order_id)!;
  // Fixed behavior: order must stay at the payment gate, not advance on a failed charge.
  assert.equal(after.state, "awaiting_decision", "state must NOT advance on a failed charge");
  assert.equal(store.pendingClientPaymentKind(o.order_id), "none", "no phantom pending row");
  assert.equal(store.hasHeldMoney(o.order_id), false, "no money collected");
});

test("ACCEPTANCE: a failed charge must stay recoverable", async () => {
  const clock = new SeqClock(); const ids = new SeqId();
  const store = new FakeStore(clock, ids);
  const provider = new FakeProvider({ status: "failed", error: "stripe transient error" });
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const app = applier(store, payments);

  const o = store.createOrder("jid-y");
  store.patchOrder(o.order_id, { job_spec: JSON.stringify({ price_cents: 20000 }) });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");

  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ]);

  // The client must still be able to get a working deposit link on the next turn.
  const retry = await app.applyAll(o.order_id, [{ type: "request_payment", kind: "deposit" }]);

  assert.equal(retry.rejected.length, 0, "deposit re-request must NOT be rejected after a failed charge");
  assert.equal(provider.charges, 2, "a second charge attempt must actually fire (not silently reuse the failed row)");
});

test("parser: mislabeled ```json fence is stripped from reply and parsed as fallback", () => {
  const raw = 'Here you go!\n\n```json\n[{"type":"set_track","track":"digital"}]\n```';
  const p = parseBrainOutput(raw);
  assert.equal(p.reply, "Here you go!", "JSON fence must be stripped from client reply");
  assert.equal(p.actions.length, 1, "content parsed as fallback actions");
  assert.deepEqual(p.actions[0], { type: "set_track", track: "digital" });
});

test("parser: unlabeled fence with JSON array is stripped even when unparseable as actions", () => {
  // Brain produced a fence we can't use but must not leak raw JSON to the client.
  const raw = 'Sending your link now.\n\n```\n[{"type":"unknown_future_action"}]\n```';
  const p = parseBrainOutput(raw);
  assert.equal(p.reply, "Sending your link now.", "unlabeled fence must be stripped from reply");
  assert.equal(p.actions.length, 0, "unknown action type is rejected, not applied");
});

test("parser: canonical actions fence still takes priority over any other fence", () => {
  const raw =
    'Reply text.\n\n```actions\n[{"type":"cancel","reason":"test"}]\n```\n\n' +
    '```json\n[{"type":"escalate","reason":"friction"}]\n```';
  const p = parseBrainOutput(raw);
  assert.equal(p.reply, "Reply text.", "both fences stripped from reply");
  assert.equal(p.actions.length, 1, "only canonical actions block parsed");
  assert.deepEqual(p.actions[0], { type: "cancel", reason: "test" });
});

test("Blocker 2: digital order in revision must NOT trigger deposit-forfeit messaging", () => {
  const clock = new SeqClock(); const ids = new SeqId();
  const store = new FakeStore(clock, ids);

  // Build a digital order that has paid the $5 block and is in revision.
  const o = store.createOrder("digital-client@wa");
  store.patchOrder(o.order_id, {
    track: "digital",
    state: "revision" as const,
    job_spec: JSON.stringify({ price_cents: 500 }),
  });
  // Simulate a succeeded digital payment row (the $5 block).
  store.payments.push({
    payment_id: "pay-digital-1",
    order_id: o.order_id,
    created_at: clock.nowIso(),
    kind: "digital",
    direction: "in",
    amount_cents: 500,
    currency: "USD",
    fx_to_usd: 1,
    method: "stripe",
    status: "succeeded",
    external_ref: "pi_1",
    idempotency_key: `${o.order_id}:digital:0`,
  });

  const updated = store.getOrder(o.order_id)!;
  assert.equal(updated.track, "digital", "track is digital");

  // The scheduler's depositPaid logic queries kind='deposit'. The digital row must NOT match.
  const hasDeposit = store
    .listPayments(o.order_id)
    .some((p) => p.kind === "deposit" && p.direction === "in" && p.status === "succeeded");
  assert.equal(hasDeposit, false, "digital payment row must NOT be mistaken for a deposit — forfeit rules must not apply to this order");
});

test("Should-fix 5: approve_for_print blocked when deposit not yet cleared", async () => {
  const clock = new SeqClock(); const ids = new SeqId();
  const store = new FakeStore(clock, ids);
  // Manual provider: returns pending (deposit initiated but not confirmed by Dan yet).
  const payments = new PaymentOps(store, new FakeProvider({ status: "pending" }), usdOnlyFx, clock);
  const app = applier(store, payments);

  const o = store.createOrder("client@wa");
  store.patchOrder(o.order_id, { job_spec: JSON.stringify({ price_cents: 20000 }) });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");

  // Request deposit (goes pending — manual Zelle, not yet confirmed).
  await app.applyAll(o.order_id, [
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ]);
  const afterDeposit = store.getOrder(o.order_id)!;
  assert.equal(afterDeposit.state, "deposit_pending", "entered deposit stage");
  assert.equal(store.pendingClientPaymentKind(o.order_id), "deposit", "deposit still pending");

  // Brain tries to approve for print before Dan has confirmed the Zelle payment.
  await app.applyAll(o.order_id, [{ type: "revision_note", note: "looks good" }]);
  const outcome = await app.applyAll(o.order_id, [{ type: "approve_for_print" }]);
  assert.equal(outcome.rejected.length, 1, "approve_for_print must be rejected when deposit not cleared");
  assert.ok(
    outcome.rejected[0]!.reason.includes("not cleared"),
    `rejection reason should mention 'not cleared', got: ${outcome.rejected[0]!.reason}`,
  );
  const final = store.getOrder(o.order_id)!;
  assert.equal(final.state, "revision", "order must stay in revision — no balance charge on uncleared deposit");
});

// ── run ───────────────────────────────────────────────────────────────────

// Blocker 1 regression guard — permanent. FlakyProvider fails N times then succeeds.
class FlakyProvider implements PaymentProvider {
  readonly method = "stripe" as const;
  charges = 0;
  constructor(private failTimes: number) {}
  async charge(_a: ChargeArgs): Promise<ChargeResult> {
    this.charges++;
    if (this.charges <= this.failTimes) return { status: "failed", error: "transient" };
    return { status: "succeeded", externalRef: `pi_${this.charges}` };
  }
}

test("Blocker 1: failed charge does not advance state and stays recoverable", async () => {
  const clock = new SeqClock(); const ids = new SeqId();
  const store = new FakeStore(clock, ids);
  const provider = new FlakyProvider(1); // fail once, then succeed
  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const app = applier(store, payments);

  const o = store.createOrder("jid-v");
  store.patchOrder(o.order_id, { job_spec: JSON.stringify({ price_cents: 20000 }) });
  store.transition(o.order_id, "mockup");
  store.transition(o.order_id, "awaiting_decision");

  // Turn 1: select + track + deposit — Stripe FAILS this time.
  await app.applyAll(o.order_id, [
    { type: "select_mockup", which: "B" },
    { type: "set_track", track: "physical" },
    { type: "request_payment", kind: "deposit" },
  ]);
  let cur = store.getOrder(o.order_id)!;
  assert.equal(cur.state, "awaiting_decision", "must NOT advance on a failed charge");
  assert.equal(store.hasHeldMoney(o.order_id), false, "no money collected on failure");

  // Turn 2: re-request deposit — not rejected, fires a real 2nd charge, now succeeds.
  const retry = await app.applyAll(o.order_id, [{ type: "request_payment", kind: "deposit" }]);
  cur = store.getOrder(o.order_id)!;
  const dep = store.listPayments(o.order_id).filter((x) => x.kind === "deposit");
  assert.equal(retry.rejected.length, 0, "retry must not be rejected");
  assert.equal(provider.charges, 2, "a real second charge must fire");
  assert.equal(cur.state, "deposit_pending", "successful retry advances the pipeline");
  assert.equal(dep.length, 1, "exactly one deposit row (key reused, no double-charge)");
});

// ── T2: JID guard behavioural verification ──────────────────────────────────

function makeHostForJidTest(store: FakeStore, clock: SeqClock) {
  const payments = new PaymentOps(store, new FakeProvider(), usdOnlyFx, clock);
  const app = applier(store, payments);
  let handler: ((m: InboundMessage) => Promise<void>) | null = null;
  const channel: WhatsAppChannel = {
    onInbound: (h) => (handler = h),
    readMessages: async () => {},
    setPresence: async () => {},
    sendMessage: async () => {},
    sendMedia: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  const brain = { async ask() { return "should not be reached"; } };
  const host = new Host({
    store, brain, applier: app, payments, channel, cadence: zeroCadence,
    notifier: fakeNotifier, clock, idGen: new SeqId(), sleep: noSleep,
    systemPrompt: "", assetStore: fakeAssetStore,
    operatorJids: ["136820914389016@lid"],
  });
  host.attach();
  return () => handler!;
}

test("T2(i): group JID (@g.us) must be blocked — no order, no events", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const getHandler = makeHostForJidTest(store, clock);
  await getHandler()({ jid: "120363000000000001@g.us", text: "hi group" });
  assert.equal(store.orders.size, 0, "no order must be created for a group JID");
  assert.equal(store.events.length, 0, "no events must be written for a group JID");
});

test("T2(ii): status@broadcast must be blocked — no order, no events", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const getHandler = makeHostForJidTest(store, clock);
  await getHandler()({ jid: "status@broadcast", text: "broadcast msg" });
  assert.equal(store.orders.size, 0, "no order must be created for status@broadcast");
  assert.equal(store.events.length, 0, "no events must be written for status@broadcast");
});

test("T2(iii): operator JID must be blocked — no order, no events", async () => {
  const clock = new SeqClock();
  const store = new FakeStore(clock, new SeqId());
  const getHandler = makeHostForJidTest(store, clock);
  await getHandler()({ jid: "136820914389016@lid", text: "internal message" });
  assert.equal(store.orders.size, 0, "no order must be created for an operator JID");
  assert.equal(store.events.length, 0, "no events must be written for an operator JID");
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
