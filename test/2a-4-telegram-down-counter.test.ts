import { describe, it, expect, beforeEach, vi } from "vitest";
import type { D } from "../src/domain/types";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { escalateForMockupFailure } from "../src/ops/escalation.js";
import type { Clock, IdGen } from "../src/domain/ports.js";

describe("2a-4: Telegram-Down Counter", () => {
  let d: D;
  let orderId: string;

  const mockClock: Clock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };

  const mockIdGen: IdGen = {
    next: () => `test-id-${Math.random().toString(36).slice(2)}`,
  };

  beforeEach(async () => {
    d = {
      store: new SqliteStore(":memory:", mockClock, mockIdGen),
      clock: mockClock,
      notifier: {
        postToPenn: vi.fn().mockRejectedValue(new Error("Telegram unavailable")),
        postToPennSafe: vi.fn().mockResolvedValue(undefined),
      },
    };

    // Create test order
    const order = d.store.createOrder("1234567890@s.whatsapp.net");
    orderId = order.order_id;
  });

  it("increments undelivered counter when Telegram is down", async () => {
    // Simulate escalation when Telegram is down
    await escalateForMockupFailure(
      d.store,
      d.notifier,
      orderId,
      "send_failed",
      `[escalation:send_failed] order ${orderId}: Baileys threw, but Telegram down too`
    );

    // Verify postToPenn was called but failed
    expect(d.notifier.postToPenn).toHaveBeenCalled();

    // Verify escalation marker was still set (even though delivery failed)
    const order = d.store.getOrder(orderId)!;
    expect(order.escalation).toBe("manual");

    // Verify event was logged with delivered:false (the counter condition)
    const events = (d.store as any).db
      .prepare("SELECT * FROM events WHERE order_id = ? AND type = 'escalation'")
      .all(orderId) as any[];

    expect(events).toHaveLength(1);
    const escalationEvent = events[0];
    const payload = JSON.parse(escalationEvent.payload);

    expect(payload.delivered).toBe(false);
    expect(payload.reason).toContain("send_failed");

    console.log(`✅ Telegram-down: escalation logged as undelivered`);
    console.log(`   Event: ${JSON.stringify(payload)}`);
  });

  it("turn does not crash when escalation delivery fails", async () => {
    // This is the safety check: even if Telegram is completely down,
    // the turn should complete, the order should be escalated, and
    // the failure should be logged (not thrown).

    let threwError = false;
    try {
      await escalateForMockupFailure(
        d.store,
        d.notifier,
        orderId,
        "send_failed",
        "Telegram down"
      );
    } catch (e) {
      threwError = true;
    }

    // Should NOT throw — escalation catches and logs
    expect(threwError).toBe(false);

    // Order should still be escalated
    const order = d.store.getOrder(orderId)!;
    expect(order.escalation).toBe("manual");

    console.log("✅ Turn completed safely despite Telegram failure");
  });

  it("counter increments only for failed deliveries (not successful ones)", async () => {
    // First: successful delivery
    const mockNotifierSuccess = {
      postToPenn: vi.fn().mockResolvedValue(undefined),
      postToPennSafe: vi.fn().mockResolvedValue(undefined),
    };

    d.notifier = mockNotifierSuccess;

    await escalateForMockupFailure(
      d.store,
      d.notifier,
      orderId,
      "send_failed",
      "This one succeeds"
    );

    let events = (d.store as any).db
      .prepare("SELECT * FROM events WHERE order_id = ? AND type = 'escalation'")
      .all(orderId) as any[];

    let payload = JSON.parse(events[0].payload);
    expect(payload.delivered).toBe(true); // ✅ Success

    // Second: failed delivery (same order, new escalation scenario)
    // To test, we need a new order to avoid re-escalation guard
    const order2 = d.store.createOrder("9876543210@s.whatsapp.net");
    const orderId2 = order2.order_id;

    d.notifier = {
      postToPenn: vi.fn().mockRejectedValue(new Error("Telegram down")),
      postToPennSafe: vi.fn().mockResolvedValue(undefined),
    };

    await escalateForMockupFailure(
      d.store,
      d.notifier,
      orderId2,
      "send_failed",
      "This one fails"
    );

    events = (d.store as any).db
      .prepare("SELECT * FROM events WHERE order_id = ? AND type = 'escalation'")
      .all(orderId2) as any[];

    payload = JSON.parse(events[0].payload);
    expect(payload.delivered).toBe(false); // ✅ Failure

    console.log("✅ Counter distinguishes delivered vs undelivered");
  });
});
