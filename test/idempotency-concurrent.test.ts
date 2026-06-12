// Concurrent idempotency test: two confirm() calls racing on the same pending payment.
// This tests the CAS (compare-and-swap) gate that fixes the concurrent delivery race.

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

// Mock the 4 payment provider methods
const mockProvider: PaymentProvider = {
  method: "stripe",
  charge: async () => ({ status: "pending", externalRef: "" }),
  getStatus: async () => "pending",
};

const mockFx = { toUsd: () => 1.0 };

describe("Concurrent idempotency: confirm() CAS gate", () => {
  it("two concurrent confirm() calls on pending payment: one wins, one no-ops", () => {
    // Create an in-memory DB
    const store = new SqliteStore(":memory:", mockClock, mockIdGen);
    const ops = new PaymentOps(store, mockProvider, mockFx, mockClock);

    // Create an order
    const order = store.createOrder("1234567890@c.us");

    // Create a pending payment
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

    // Simulate two concurrent deliveries hitting the same pending row
    // In real code, these would be async tasks. Here we execute sequentially
    // but the DB-level CAS ensures only one succeeds.
    
    const tx = store["db"].transaction(() => {
      const result1 = ops.confirmInTransaction(payment.payment_id, "cs_test123");
      // After first confirm: won===true, status flipped to succeeded
      expect(result1.won).toBe(true);
      expect(result1.payment.status).toBe("succeeded");

      // Second confirm on same row: row is no longer pending
      // CAS fails: changes===0
      const result2 = ops.confirmInTransaction(payment.payment_id, "cs_test123");
      expect(result2.won).toBe(false); // Loser: CAS failed
      expect(result2.payment.status).toBe("succeeded"); // Row is already succeeded
    });
    
    tx();

    // Verify: only one payment event appended (no double-event)
    const events = store["db"]
      .prepare("SELECT * FROM events WHERE order_id = ? AND type = 'payment'")
      .all(order.order_id) as any[];
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatch(/succeeded/);

    // Verify: payment is succeeded (settled once, not twice)
    const final = store.getPayment(payment.payment_id);
    expect(final?.status).toBe("succeeded");
    expect(final?.external_ref).toBe("cs_test123");
  });
});
