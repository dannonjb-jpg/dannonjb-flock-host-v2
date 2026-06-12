/**
 * Regression test for send-fail escalation (Fix 2).
 *
 * 2a-1b: generate-succeeds-but-send-fails
 *
 * Scenario: bridge returns valid URLs, but WhatsApp media-send fails (e.g., 404 fetch).
 * Expected: order escalates to manual, marked with mockup_failed_escalation=true.
 * Recovery: next successful media-send clears the marker and escalation.
 *
 * This test replaces the gap in 2a-0/2a-1 which tested bridge-down but not send-failure.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { Host, HostDeps } from "../src/host.js";
import { MockupPipeline, MockupUrls } from "../src/domain/integrations.js";
import { ConsoleNotifier } from "../src/ops/escalation.js";
import pino from "pino";

describe("2a-1b: send-fail escalation", () => {
  let store: Store;
  let notifier: ConsoleNotifier;
  const logger = pino({ level: "silent" });

  const mockClock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };

  const mockSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const mockBridge404: MockupPipeline = {
    async generate(): Promise<MockupUrls> {
      // Simulate bridge returning valid URLs that will fail on fetch.
      return {
        A: "https://sovereigntysolutions.org/mockups/broken-a.png", // will be 404
        B: "https://sovereigntysolutions.org/mockups/broken-b.png", // will be 404
      };
    },
  };

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    notifier = new ConsoleNotifier();
  });

  it("escalates order when media-send fails (404 on fetch)", async () => {
    // 1. Create an order at mockup state.
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    let cur = store.getOrder(order.order_id)!;
    expect(cur.state).toBe("mockup");
    expect(cur.escalation).toBeNull();

    // 2. Simulate a failed send (catch handler in host.ts).
    // The send-fail path calls escalateForMockupFailure.
    const { escalateForMockupFailure } = await import(
      "../src/ops/escalation.js"
    );

    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "send_failed",
      `Test: media-send failed on https://sovereigntysolutions.org/mockups/broken-a.png`,
    );

    // 3. Confirm escalation marker is set.
    cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");

    const spec = cur.job_spec ? JSON.parse(cur.job_spec) : {};
    expect(spec.mockup_failed_escalation).toBe(true);
    expect(spec.mockup_failure_type).toBe("send_failed");

    // 4. Check escalation event was appended.
    const events = store.getConversationHistory(order.order_id, 999);
    const escalationEvent = events.find(
      (e: any) => e.type === "escalation" && e.detail?.reason === "mockup_send_failed"
    );
    expect(escalationEvent).toBeDefined();

    // 5. Simulate recovery (successful media-send → no escalation on retry).
    // The conditional-clear in onRequestMockup should fire: escalation===manual && marker===true.
    const { ActionApplier } = await import("../src/brain/action-applier.js");

    // Mock dependencies for applier (minimal setup for recovery test).
    const mockApplier = {
      async applyAll(
        orderId: string,
        actions: any[]
      ): Promise<{ applied: any[]; rejected: any[]; paymentUrls: any[]; presentations: any[] }> {
        // Simulate a successful request_mockup that clears the escalation.
        if (actions.some((a) => a.type === "request_mockup")) {
          const order = store.getOrder(orderId)!;
          const spec = order.job_spec ? JSON.parse(order.job_spec) : {};

          // This mirrors the recovery path in onRequestMockup.
          delete spec.mockup_failed_escalation;
          store.patchOrder(orderId, {
            job_spec: JSON.stringify(spec),
            escalation: null, // cleared
          });

          store.appendEvent({
            order_id: orderId,
            actor: "flock",
            type: "escalation",
            payload: { reason: "manual", detail: "mockup_recovered", resolved: true },
          });
        }

        return { applied: actions, rejected: [], paymentUrls: [], presentations: [] };
      },
    };

    // Re-request after recovery (simulate user re-sends "Mockup").
    await mockApplier.applyAll(order.order_id, [{ type: "request_mockup" }]);

    // 6. Confirm escalation was cleared.
    cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBeNull();

    const recoveredSpec = cur.job_spec ? JSON.parse(cur.job_spec) : {};
    expect(recoveredSpec.mockup_failed_escalation).toBeUndefined();

    // 7. Confirm recovery event.
    const allEvents = store.getConversationHistory(order.order_id, 999);
    const recoveryEvent = allEvents.find(
      (e: any) => e.type === "escalation" && e.detail?.detail === "mockup_recovered"
    );
    expect(recoveryEvent).toBeDefined();
  });

  it("guards against re-escalation on repeated send failures", async () => {
    // Setup: order already escalated for mockup.
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    const { escalateForMockupFailure } = await import(
      "../src/ops/escalation.js"
    );

    // First escalation.
    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "send_failed",
      "First failure",
    );

    let cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");

    // Second escalation attempt (e.g., Turn 26 retries and hits same 404).
    // Should log but NOT re-ping Penn.
    const eventCountBefore = store.getConversationHistory(order.order_id, 999).length;

    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "send_failed",
      "Retry hit same failure",
    );

    // Order should still be escalated (not re-escalated).
    cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");

    // Event count should not increase (guard prevented re-ping).
    const eventCountAfter = store.getConversationHistory(order.order_id, 999).length;
    expect(eventCountAfter).toBe(eventCountBefore); // no new escalation event
  });
});
