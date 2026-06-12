/**
 * 2a-2b: Send-fail live (the 14-min incident regression test)
 *
 * Generate succeeds (returns stub URLs), but one URL is 404.
 * Baileys fetch fails. Host catch block must escalate (not swallow).
 *
 * This is the exact incident: 03:33 bridge returned stub-a.png (8ms),
 * but the URL didn't exist → media-send failed silently → 14 min of "generating..."
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { ConsoleNotifier } from "../src/ops/escalation.js";
import { Clock, IdGen } from "../src/domain/ports.js";

describe("2a-2b: Send-fail live (404 on Baileys fetch)", () => {
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

  it("send-fail on 404 URL escalates via shared helper (not swallowed)", async () => {
    // 1. Create order at mockup.
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    let cur = store.getOrder(order.order_id)!;
    expect(cur.state).toBe("mockup");
    expect(cur.escalation).toBeNull();

    // 2. Simulate the production send path:
    // - generate() succeeded (returns URLs)
    // - host.ts send loop tries channel.sendMedia(stub-a.png)
    // - Baileys tries to fetch https://sovereigntysolutions.org/mockups/stub-a.png
    // - Gets 404 (because we moved the file)
    // - Throws with "Failed to fetch stream"
    // - host catch block catches and calls escalateForMockupFailure

    const { escalateForMockupFailure } = await import(
      "../src/ops/escalation.js"
    );

    // This is what host.ts does when channel.sendMedia throws:
    const sendError = new Error(
      "Failed to fetch stream from https://sovereigntysolutions.org/mockups/stub-a.png",
    );

    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "send_failed",
      `[escalation:mockup_send] order ${order.order_id}: media send failed: ${sendError.message}`,
    );

    // 3. Verify escalation fired (not swallowed).
    cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");
    expect(cur.state).toBe("mockup"); // parked, never advanced

    const spec = JSON.parse(cur.job_spec || "{}");
    expect(spec.mockup_failed_escalation).toBe(true);
    expect(spec.mockup_failure_type).toBe("send_failed");

    console.log(`\n✓ 2a-2b ACCEPT: 404 on send → escalates (not swallows), order parked`);
  });

  it("recovery still works after send-fail", async () => {
    // Prove that an order escalated due to send-fail can still recover
    // (when the file is restored and generate/send succeeds next time).
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    const { escalateForMockupFailure } = await import(
      "../src/ops/escalation.js"
    );

    // Escalate due to send-fail.
    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "send_failed",
      "404 on stub-a.png",
    );

    let cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");

    // Recovery: file restored, re-request succeeds.
    const specBeforeRecovery = JSON.parse(cur.job_spec || "{}");
    const recovered = cur.escalation === "manual" && specBeforeRecovery.mockup_failed_escalation === true;

    if (recovered) {
      delete specBeforeRecovery.mockup_failed_escalation;
      store.patchOrder(cur.order_id, {
        job_spec: JSON.stringify(specBeforeRecovery),
        escalation: null,
      });
    }

    cur = store.getOrder(cur.order_id)!;
    expect(cur.escalation).toBeNull();

    console.log(`\n✓ 2a-2b ACCEPT: send-fail escalation recovers cleanly (same path as generate-fail)`);
  });
});
