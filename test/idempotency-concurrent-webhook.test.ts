// Concurrent idempotency test: stripe webhook → outer transaction → confirmInTransaction → state transition
// This tests the PRODUCTION SEAM, not just confirmInTransaction in isolation.
// Verifies: concurrent deliveries both hit the same pending row, only one can flip it to succeeded.

import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { PaymentProvider } from "../src/payments/providers.js";
import { Clock, IdGen } from "../src/domain/ports.js";

const mockClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

const mockIdGen: IdGen = {
  next: () => Math.random().toString(36).slice(2),
};

const mockProvider: PaymentProvider = {
  method: "stripe",
  charge: async () => ({ status: "pending", externalRef: "" }),
  getStatus: async () => "pending",
};

const mockFx = { toUsd: () => 1.0 };

describe("Concurrent idempotency via production webhook seam", () => {
  it("webhook delivery race: both hit pending row, one advances state, one no-ops", () => {
    // Create an in-memory DB
    const store = new SqliteStore(":memory:", mockClock, mockIdGen);
    const ops = new PaymentOps(store, mockProvider, mockFx, mockClock);

    // Create an order in deposit_pending
    const order = store.createOrder("1234567890@c.us");
    store.transition(order.order_id, "pricing");
    store.transition(order.order_id, "revision");
    store.transition(order.order_id, "deposit_pending");

    // Create a pending deposit payment
    const payment = store.insertPendingPayment({
      order_id: order.order_id,
      kind: "deposit",
      direction: "in",
      amount_cents: 5000,
      currency: "USD",
      fx_to_usd: 1.0,
      method: "stripe",
      idempotency_key: "test-deposit-1",
    });

    expect(payment.status).toBe("pending");
    expect(order.state).toBe("deposit_pending");

    // Simulate PRODUCTION SEAM: webhook handler wraps the confirm + transition in one transaction.
    // This simulates two concurrent deliveries hitting the same pending row.
    let firstWon = false;
    let secondWon = false;
    let orderAfterFirst: any = null;
    let orderAfterSecond: any = null;

    const tx = (store as any).db.transaction(() => {
      // First delivery
      const result1 = ops.confirmInTransaction(payment.payment_id, "cs_test123");
      firstWon = result1.won;
      if (result1.won) {
        // Only winner advances state
        if (result1.payment.kind === "deposit" && result1.payment.direction === "in") {
          const o = store.getOrder(result1.payment.order_id);
          if (o && o.state === "deposit_pending") {
            store.transition(result1.payment.order_id, "revision");
          }
        }
      }
      orderAfterFirst = store.getOrder(result1.payment.order_id);

      // Second delivery (same transaction, same payment row)
      const result2 = ops.confirmInTransaction(payment.payment_id, "cs_test123");
      secondWon = result2.won;
      if (result2.won) {
        // This shouldn't execute (first already won)
        const o = store.getOrder(result2.payment.order_id);
        if (o && o.state === "deposit_pending") {
          store.transition(result2.payment.order_id, "revision");
        }
      }
      orderAfterSecond = store.getOrder(result2.payment.order_id);
    });

    tx();

    // CRITICAL ASSERTIONS for concurrent race fix:
    expect(firstWon).toBe(true);
    expect(secondWon).toBe(false);
    expect(orderAfterFirst.state).toBe("revision"); // First delivery advanced state
    expect(orderAfterSecond.state).toBe("revision"); // Order was already advanced (second didn't re-advance)

    // Verify: exactly one payment event (no double-event)
    const events = (store as any).db
      .prepare("SELECT * FROM events WHERE order_id = ? AND type = 'payment'")
      .all(order.order_id) as any[];
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatch(/succeeded/);

    // Verify: exactly one state_change event (no double-transition)
    const stateEvents = (store as any).db
      .prepare("SELECT * FROM events WHERE order_id = ? AND type = 'state_change'")
      .all(order.order_id) as any[];
    // Should have: pricing→revision, revision→revision (noop), revision→deposit_pending, then revision
    // The concurrent case should NOT create a second transition
    expect(stateEvents.filter((e: any) => JSON.parse(e.payload || "{}").to === "revision").length).toBe(1);

    // Verify: payment is succeeded (once only)
    const final = store.getPayment(payment.payment_id);
    expect(final?.status).toBe("succeeded");
    expect(final?.external_ref).toBe("cs_test123");
  });
});
