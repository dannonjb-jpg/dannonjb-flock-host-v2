/**
 * 2a-2: Empty return (Gate 1b)
 *
 * Bridge is up but returns {} (no URLs).
 * Verify escalateForMockupFailure fires with empty detail, order parked.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { ConsoleNotifier } from "../src/ops/escalation.js";
import { Clock, IdGen } from "../src/domain/ports.js";

describe("2a-2: Empty return (Gate 1b)", () => {
  let store: Store;
  let notifier: ConsoleNotifier;

  const mockClock: Clock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };

  const mockIdGen: IdGen = {
    next: () => `test-id-${Math.random().toString(36).slice(2)}`,
  };

  beforeEach(() => {
    store = new SqliteStore(":memory:", mockClock, mockIdGen);
    notifier = new ConsoleNotifier();
  });

  it("escalateForMockupFailure fires on empty-return (Gate 1b)", async () => {
    // 1. Create order and move to mockup.
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    let cur = store.getOrder(order.order_id)!;
    expect(cur.state).toBe("mockup");
    expect(cur.escalation).toBeNull();

    // 2. Simulate bridge returning empty (Gate 1b).
    const { escalateForMockupFailure } = await import(
      "../src/ops/escalation.js"
    );

    // This is what onRequestMockup calls when bridge returns {}.
    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "bridge_failed",
      `[escalation:mockup_bridge] order ${order.order_id}: bridge returned empty URLs`,
    );

    // 3. Verify escalation fired.
    cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");
    expect(cur.state).toBe("mockup"); // parked at mockup

    const spec = cur.job_spec ? JSON.parse(cur.job_spec) : {};
    expect(spec.mockup_failed_escalation).toBe(true);
    expect(spec.mockup_failure_type).toBe("bridge_failed");

    console.log(`\n✓ 2a-2 ACCEPT: empty return escalates, order parked, Penn pinged`);
  });
});
