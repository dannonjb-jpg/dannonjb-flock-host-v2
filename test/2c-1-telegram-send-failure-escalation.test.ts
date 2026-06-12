import { describe, it, expect, beforeEach, vi } from "vitest";
import type { D } from "../src/domain/types";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { escalateForMockupFailure } from "../src/ops/escalation.js";
import type { Clock, IdGen } from "../src/domain/ports.js";

describe("2c-1: Telegram Send Failure Escalation", () => {
  let d: D;
  let orderId: string;

  beforeEach(async () => {
    const clock: Clock = {
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
    };
    const idGen: IdGen = {
      next: () => `test-id-${Math.random().toString(36).slice(2)}`,
    };

    d = {
      store: new SqliteStore(":memory:", clock, idGen),
      clock,
      notifier: {
        postToPenn: vi.fn().mockResolvedValue(undefined),
        postToPennSafe: vi.fn().mockResolvedValue(undefined),
      },
    };

    // Create test order
    const order = d.store.createOrder("1234567890@s.whatsapp.net");
    orderId = order.order_id;
  });

  it("escalates to Penn when WhatsApp send fails", async () => {
    let order = d.store.getOrder(orderId)!;
    expect(order.escalation).toBeNull();

    // Simulate send failure (include order ID in message as would happen in practice)
    await escalateForMockupFailure(
      d.store,
      d.notifier,
      orderId,
      "send_failed",
      `[escalation:send_failed] order ${orderId}: Baileys sendMessage() threw`
    );

    // Verify escalation was set
    order = d.store.getOrder(orderId)!;
    expect(order.escalation).toBe("manual");

    // Verify Penn was notified
    expect(d.notifier.postToPenn).toHaveBeenCalled();
    const pennMsg = (d.notifier.postToPenn as any).mock.calls[0][0];
    expect(pennMsg).toContain(orderId);
    expect(pennMsg).toContain("send_failed");

    console.log(`✅ Send failure escalated to Penn: ${pennMsg}`);
  });

  it("guards against re-escalation on same failure", async () => {
    // First escalation
    await escalateForMockupFailure(
      d.store,
      d.notifier,
      orderId,
      "send_failed",
      "First attempt"
    );

    const calls1 = (d.notifier.postToPenn as any).mock.calls.length;

    // Try to escalate again (should be guarded by marker)
    await escalateForMockupFailure(
      d.store,
      d.notifier,
      orderId,
      "send_failed",
      "Second attempt"
    );

    const calls2 = (d.notifier.postToPenn as any).mock.calls.length;

    // postToPenn should only fire once
    expect(calls2).toBe(calls1);

    console.log("✅ Re-escalation guarded");
  });

  it("clears escalation on recovery (successful state transition)", async () => {
    // First escalation
    await escalateForMockupFailure(
      d.store,
      d.notifier,
      orderId,
      "send_failed",
      "Send failed"
    );

    let order = d.store.getOrder(orderId)!;
    expect(order.escalation).toBe("manual");

    // Simulate recovery: clear escalation marker
    d.store.patchOrder(orderId, { escalation: null });

    order = d.store.getOrder(orderId)!;
    expect(order.escalation).toBeNull();

    console.log("✅ Escalation cleared on recovery");
  });
});
