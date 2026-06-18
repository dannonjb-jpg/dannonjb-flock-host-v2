// test/content-gate.test.ts
// 10 scenarios covering the content-gate feature:
//   Part A — moderateAsset keyword scanner
//   Part B — ip_attestation via collect
//   Part C — onConfirmAsset moderation + attestation + Penn calibration alert
//   Part D — shop_rejected state + issueRefund + shopRejectOrder

import assert from "node:assert";

import { moderateAsset } from "../src/moderation/moderate.js";
import { canTransition, isTerminal } from "../src/domain/state-machine.js";
import { TERMINAL_STATES, Order, OrderState, Payment, PaymentStatus, EventRow } from "../src/domain/types.js";
import { shopRejectOrder } from "../src/ops/shop-reject.js";
import { ActionApplier } from "../src/brain/action-applier.js";
import { PaymentOps, PriceUnavailable } from "../src/payments/payment-ops.js";
import { usdOnlyFx, ChargeResult, ChargeArgs } from "../src/payments/providers.js";
import { Store, NewEvent, NewPayment, Quote, IdempotencyCollision } from "../src/store/store.js";
import { Clock, IdGen } from "../src/domain/ports.js";
import { assertTransition } from "../src/domain/state-machine.js";
import { Notifier, MockupPipeline, SupplierQueue, Delivery } from "../src/domain/integrations.js";
import { AssetStore, AssetMeta, ResolvedAsset } from "../src/store/asset-store.js";

// ── tiny harness ────────────────────────────────────────────────────────────
let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ── deterministic clock + ids ───────────────────────────────────────────────
class SeqClock implements Clock {
  private t = 1_700_000_000_000;
  nowIso() { return new Date((this.t += 1000)).toISOString(); }
  nowMs() { return this.t; }
}
class SeqId implements IdGen {
  private n = 0;
  next() { return `cg-${++this.n}`; }
}

// ── minimal FakeStore ───────────────────────────────────────────────────────
class FakeStore implements Store {
  orders = new Map<string, Order>();
  payments: Payment[] = [];
  events: EventRow[] = [];
  quotes: Quote[] = [];
  // Expose db shape so confirmInTransaction guard passes if called
  db = { inTransaction: true, transaction: (fn: () => unknown) => fn };

  constructor(private clock: Clock, private ids: IdGen) {}

  createOrder(jid: string): Order {
    const now = this.clock.nowIso();
    const o: Order = {
      order_id: this.ids.next(),
      created_at: now, updated_at: now,
      whatsapp_jid: jid,
      client_name: null, business_name: null, project_type: null,
      job_spec: null,
      track: "undecided", selected_mockup: null,
      state: "intake",
      dormant_since: null, follow_up_stage: 0,
      escalation: null, dispute_flag: 0,
      failed_mockup_pairs: 0, digital_rounds_used: 0,
      assigned_supplier_id: null, hermes_session_id: null,
      turn_count: 0, last_tier: null, force_tier: null, notes: null,
      fulfillment_method: null, delivery_address: null,
      shipping_tier: null, shipping_cents: null, ready_to_ship_date: null,
      shop_rejected_reason: null,
    };
    this.orders.set(o.order_id, o);
    return { ...o };
  }
  getOrder(id: string) { const o = this.orders.get(id); return o ? { ...o } : null; }
  findActiveOrderByJid(jid: string) {
    const list = [...this.orders.values()].filter(
      (o) => o.whatsapp_jid === jid && !isTerminal(o.state),
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
    const row: Payment = { payment_id: this.ids.next(), created_at: this.clock.nowIso(), status: "pending", external_ref: null, ...p };
    this.payments.push(row);
    return { ...row };
  }
  getPaymentByKey(key: string) { const p = this.payments.find((x) => x.idempotency_key === key); return p ? { ...p } : null; }
  getPayment(id: string) { const p = this.payments.find((x) => x.payment_id === id); return p ? { ...p } : null; }
  markPaymentStatus(id: string, status: PaymentStatus, ref?: string | null) {
    const p = this.payments.find((x) => x.payment_id === id)!;
    p.status = status;
    if (ref !== undefined) p.external_ref = ref ?? null;
    return { ...p };
  }
  markPaymentStatusIfPending(id: string, status: PaymentStatus, ref?: string | null) {
    const p = this.payments.find((x) => x.payment_id === id && x.status === "pending");
    if (!p) return { changes: 0, payment: this.payments.find((x) => x.payment_id === id) ?? null };
    p.status = status;
    if (ref !== undefined) p.external_ref = ref ?? null;
    return { changes: 1, payment: { ...p } };
  }
  listPayments(orderId: string) { return this.payments.filter((p) => p.order_id === orderId).map((p) => ({ ...p })); }
  pendingClientPaymentKind() { return "none" as const; }
  hasHeldMoney(orderId: string) {
    return this.payments.some((x) => x.order_id === orderId && x.direction === "in" && x.status === "succeeded");
  }
  succeededDigitalBlocks(orderId: string) {
    return this.payments.filter((x) => x.order_id === orderId && x.kind === "digital" && x.direction === "in" && x.status === "succeeded").length;
  }
  succeededRevisionBlocks(orderId: string) {
    return this.payments.filter((x) => x.order_id === orderId && x.kind === "revision" && x.direction === "in" && x.status === "succeeded").length;
  }
  appendEvent(e: NewEvent): EventRow {
    const row: EventRow = {
      event_id: this.ids.next(), order_id: e.order_id, created_at: this.clock.nowIso(),
      actor: e.actor, type: e.type,
      payload: e.payload !== undefined ? JSON.stringify(e.payload) : null,
      inbound_event_id: e.inbound_event_id ?? null,
    };
    this.events.push(row);
    return { ...row };
  }
  getEvent(id: string) { return this.events.find((e) => e.event_id === id) ?? null; }
  findUnansweredInbound() { return []; }
  findPendingPaymentsWithExternalRef() { return []; }
  findOrphanedPendingPayments() { return []; }
  listPendingManualPayments() { return []; }
  getLastClientMessageTime() { return null; }
  inboundHasReply() { return false; }
  getConversationHistory() { return []; }
  getSelectedQuote() { return null; }
  findQuietOrders() { return []; }
  setDormancy(id: string, d: string | null, s: number) {
    const o = this.orders.get(id)!;
    o.dormant_since = d; o.follow_up_stage = s;
    return { ...o };
  }
  getStateEntryTime() { return null; }
  getAllNonTerminalOrders() { return [...this.orders.values()].filter((o) => !isTerminal(o.state)); }
  getDailyMockupSpendCents() { return 0; }
  getLastRejectedAction() { return null; }
  close() {}
}

// ── FakeAssetStore with controllable bytes ───────────────────────────────────
class FakeAssetStore {
  private _pending: AssetMeta[] = [];
  private _bytes = new Map<string, Buffer>();
  confirmCalled: string[] = [];

  seed(meta: Partial<AssetMeta> & { asset_id: string }, bytes: Buffer) {
    const full: AssetMeta = {
      asset_id: meta.asset_id, jid: meta.jid ?? "test-jid",
      bytes_hash: "fakehash", asset_type: "unknown", role: "unknown",
      role_source: "proposed_unconfirmed", resolution_hint: "unknown",
      width_px: null, height_px: null, is_vector: false,
      version: 0, is_current: false, source_message: null,
      created_at: new Date().toISOString(),
      ...meta,
    };
    this._pending.push(full);
    this._bytes.set(meta.asset_id, bytes);
  }

  pendingAssets(_jid: string): AssetMeta[] { return this._pending; }
  resolveLogo() { return null; }
  resolveAsset() { return null; }
  resolveAssetMeta() { return null; }
  resolvePendingByRef() { return null; }
  writeAsset() { return Promise.resolve("fake-asset-id"); }
  confirmAssetRole(assetId: string) { this.confirmCalled.push(assetId); }
  resolveAssetById(assetId: string): ResolvedAsset | null {
    const bytes = this._bytes.get(assetId);
    const meta = this._pending.find((m) => m.asset_id === assetId);
    if (!bytes || !meta) return null;
    return { ...meta, content: bytes, bytes_size: bytes.length };
  }
}

// ── FakePaymentProvider ────────────────────────────────────────────────────
const fakeProvider = {
  method: "stripe" as const,
  async charge(_a: ChargeArgs): Promise<ChargeResult> { return { status: "succeeded", externalRef: "ch_fake" }; },
};

// ── builders ────────────────────────────────────────────────────────────────
function makeStore() {
  const clock = new SeqClock(); const ids = new SeqId();
  return { store: new FakeStore(clock, ids), clock, ids };
}

function makeApplier(store: FakeStore, assetStore: FakeAssetStore, pennLog: string[]) {
  const clock = new SeqClock(); const ids = new SeqId();
  const payments = new PaymentOps(store, fakeProvider, usdOnlyFx, clock);
  const notifier: Notifier = { async postToPenn(t) { pennLog.push(t); } };
  return new ActionApplier({
    store,
    payments,
    assetStore: assetStore as unknown as AssetStore,
    mockups: { async generate() { return { A: "a.png", B: "b.png" }; } } as MockupPipeline,
    supplierQueue: { async queueRevision() {} } as SupplierQueue,
    delivery: { async deliverFinal() { return { url: "final.pdf" }; } } as Delivery,
    notifier,
    clock,
    defaultMethod: "stripe",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// TEST 1: moderateAsset — clean bytes pass
// ────────────────────────────────────────────────────────────────────────────
test("1: moderateAsset — clean bytes return ok:true", async () => {
  const result = await moderateAsset({
    bytes: Buffer.from("company logo design clean branding"),
    mimeType: "image/png",
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 2: moderateAsset — "explicit" keyword triggers blocklist
// ────────────────────────────────────────────────────────────────────────────
test('2: moderateAsset — "explicit" keyword returns ok:false', async () => {
  const result = await moderateAsset({
    bytes: Buffer.from("this image contains explicit content"),
    mimeType: "image/jpeg",
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason?.includes("explicit"), `expected reason to mention explicit, got: ${result.reason}`);
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 3: moderateAsset — hate speech pattern triggers
// ────────────────────────────────────────────────────────────────────────────
test("3: moderateAsset — hate speech pattern returns ok:false", async () => {
  const result = await moderateAsset({
    bytes: Buffer.from("heil hitler 88"),
    mimeType: "image/png",
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason?.includes("hate"), `expected hate speech reason, got: ${result.reason}`);
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 4: moderateAsset — nsfw keyword triggers
// ────────────────────────────────────────────────────────────────────────────
test("4: moderateAsset — nsfw keyword triggers blocklist", async () => {
  const result = await moderateAsset({
    bytes: Buffer.from("nsfw content warning"),
    mimeType: "image/jpeg",
  });
  assert.strictEqual(result.ok, false);
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 5: onConfirmAsset — clean bytes proceed, confirmAssetRole called
// ────────────────────────────────────────────────────────────────────────────
test("5: onConfirmAsset — clean asset proceeds and confirms", async () => {
  const { store } = makeStore();
  const order = store.createOrder("jid-5");
  const assetStore = new FakeAssetStore();
  assetStore.seed({ asset_id: "asset-5", jid: "jid-5" }, Buffer.from("clean logo design"));
  const pennLog: string[] = [];
  const applier = makeApplier(store, assetStore, pennLog);

  const result = await applier.applyAll(order.order_id, [{ type: "confirm_asset", asset_type: "logo" }], "evt-5");

  assert.deepStrictEqual(result.rejected, []);
  assert.strictEqual(assetStore.confirmCalled[0], "asset-5");
  assert.strictEqual(pennLog.length, 0, "no Penn alert for clean asset");
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 6: onConfirmAsset — flagged bytes, no attestation → rejection
// ────────────────────────────────────────────────────────────────────────────
test("6: onConfirmAsset — flagged asset without attestation is rejected", async () => {
  const { store } = makeStore();
  const order = store.createOrder("jid-6");
  const assetStore = new FakeAssetStore();
  assetStore.seed({ asset_id: "asset-6", jid: "jid-6" }, Buffer.from("explicit content logo"));
  const pennLog: string[] = [];
  const applier = makeApplier(store, assetStore, pennLog);

  const result = await applier.applyAll(order.order_id, [{ type: "confirm_asset", asset_type: "logo" }], "evt-6");

  assert.strictEqual(result.rejected.length, 1);
  assert.ok(
    result.rejected[0]!.reason.includes("moderation"),
    `expected moderation reason, got: ${result.rejected[0]!.reason}`,
  );
  assert.strictEqual(assetStore.confirmCalled.length, 0, "confirmAssetRole must not be called on flagged unattested");
  assert.strictEqual(pennLog.length, 0, "no Penn alert without attestation");
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 7: onConfirmAsset — flagged + attested → proceeds + Penn calibration alert
// ────────────────────────────────────────────────────────────────────────────
test("7: onConfirmAsset — flagged + attested proceeds and pings Penn", async () => {
  const { store } = makeStore();
  const order = store.createOrder("jid-7");
  // Seed ip_attestation via patchOrder (simulates prior collect action)
  store.patchOrder(order.order_id, {
    job_spec: JSON.stringify({
      ip_attestation: {
        attested_at: new Date().toISOString(),
        client_confirms_rights: true,
        prompt_shown: "Do you confirm you own all rights to this image?",
      },
    }),
  });
  const freshOrder = store.getOrder(order.order_id)!;

  const assetStore = new FakeAssetStore();
  assetStore.seed({ asset_id: "asset-7", jid: "jid-7" }, Buffer.from("explicit content logo"));
  const pennLog: string[] = [];
  const applier = makeApplier(store, assetStore, pennLog);

  const result = await applier.applyAll(freshOrder.order_id, [{ type: "confirm_asset", asset_type: "logo" }], "evt-7");

  assert.deepStrictEqual(result.rejected, []);
  assert.strictEqual(assetStore.confirmCalled[0], "asset-7", "asset should be confirmed");
  // Wait one tick for the non-blocking Penn call
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pennLog.length, 1, "Penn must receive one calibration alert");
  assert.ok(pennLog[0]!.includes("[flagged-and-attested]"), `expected [flagged-and-attested] tag, got: ${pennLog[0]}`);
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 8: shop_rejected is in TERMINAL_STATES
// ────────────────────────────────────────────────────────────────────────────
test("8: shop_rejected is terminal", () => {
  assert.ok(TERMINAL_STATES.has("shop_rejected"), "shop_rejected must be in TERMINAL_STATES");
  assert.strictEqual(isTerminal("shop_rejected"), true);
  assert.strictEqual(isTerminal("revision"), false);
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 9: shop_rejected state machine transitions
// ────────────────────────────────────────────────────────────────────────────
test("9: shop_rejected transition rules", () => {
  // Every non-terminal can go to shop_rejected
  const nonTerminals: OrderState[] = [
    "intake", "mockup", "awaiting_decision", "deposit_pending",
    "digital_pending", "revision", "balance_pending", "in_production",
    "received", "delivered",
  ];
  for (const s of nonTerminals) {
    assert.ok(canTransition(s, "shop_rejected"), `expected ${s} → shop_rejected to be legal`);
  }
  // Terminal states cannot transition anywhere
  assert.strictEqual(canTransition("shop_rejected", "cancelled"), false);
  assert.strictEqual(canTransition("shop_rejected", "closed"), false);
  assert.strictEqual(canTransition("shop_rejected", "intake"), false);
  // Other terminals still blocked
  assert.strictEqual(canTransition("closed", "shop_rejected"), false);
});

// ────────────────────────────────────────────────────────────────────────────
// TEST 10: shopRejectOrder — transitions + refund + Penn notification
// ────────────────────────────────────────────────────────────────────────────
test("10: shopRejectOrder — transitions, issues refund, notifies Penn", async () => {
  const clock = new SeqClock();
  const ids = new SeqId();
  const store = new FakeStore(clock, ids);
  const order = store.createOrder("jid-10");

  // Advance to revision (money has been collected)
  store.transition(order.order_id, "mockup");
  store.transition(order.order_id, "awaiting_decision");
  store.transition(order.order_id, "deposit_pending");
  store.transition(order.order_id, "revision");

  // Inject a succeeded deposit payment so hasHeldMoney returns true
  store.insertPendingPayment({
    order_id: order.order_id, kind: "deposit", direction: "in",
    amount_cents: 5000, currency: "USD", fx_to_usd: 1,
    method: "stripe", idempotency_key: `${order.order_id}:deposit:1`,
  });
  store.markPaymentStatus(store.payments[0]!.payment_id, "succeeded", "ch_test");

  const payments = new PaymentOps(store, fakeProvider, usdOnlyFx, clock);
  const pennLog: string[] = [];
  const notifier: Notifier = { async postToPenn(t) { pennLog.push(t); } };

  await shopRejectOrder(store, payments, notifier, order.order_id, "prohibited content");

  // Order must now be in shop_rejected
  const final = store.getOrder(order.order_id)!;
  assert.strictEqual(final.state, "shop_rejected");
  assert.strictEqual(final.shop_rejected_reason, "prohibited content");

  // A refund payment must have been created and succeeded
  const refund = store.payments.find((p) => p.kind === "refund");
  assert.ok(refund, "refund payment must exist");
  assert.strictEqual(refund!.direction, "out");
  assert.strictEqual(refund!.amount_cents, 5000, "refund must match collected amount");
  assert.strictEqual(refund!.status, "succeeded");
  assert.strictEqual(refund!.idempotency_key, `${order.order_id}:refund:shop_rejected`);

  // Penn must be notified
  assert.ok(pennLog.some((m) => m.includes("[shop_rejected]")), "Penn must receive shop_rejected notification");
});

// ── runner ──────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${name}`);
      console.error(e);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exit(1);
})();
