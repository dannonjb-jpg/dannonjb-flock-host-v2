/**
 * Watchdog test for stuck mockup with persistent pinger (Fix 3).
 *
 * Reproduces the actual incident: order enters mockup, customer pings every minute,
 * host reassures each time (bumping updated_at), but order never actually advances
 * because media-send failed (or generate never happened).
 *
 * With updated_at anchor, watchdog never fires (customer is "active").
 * With state-entry anchor, watchdog fires correctly after 2 min in mockup.
 *
 * This test FAILS if watchdog anchors to updated_at (the bug).
 * This test PASSES if watchdog anchors to state-entry time (the fix).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { Scheduler } from "../src/ops/scheduler.js";
import { ConsoleNotifier } from "../src/ops/escalation.js";
import { Clock, IdGen } from "../src/domain/ports.js";
import pino from "pino";

describe("Fix 3: Mockup watchdog with persistent pinger", () => {
  let store: Store;
  let notifier: ConsoleNotifier;
  let currentTime = Date.now();

  const mockClock: Clock = {
    nowMs: () => currentTime,
    nowIso: () => new Date(currentTime).toISOString(),
  };

  const mockIdGen: IdGen = {
    next: () => `mock-id-${Math.random().toString(36).slice(2)}`,
  };

  const mockSleep = () => Promise.resolve();
  const mockBrain = { ask: async () => "" };
  const mockApplier = { applyAll: async () => ({ applied: [], rejected: [], paymentUrls: [], presentations: [] }) };
  const mockChannel = {
    setPresence: async () => {},
    sendMessage: async () => {},
  };
  const mockCadence = { typingMs: () => 0 };

  let mockSchedulerDeps: any;

  beforeEach(() => {
    currentTime = Date.now();
    store = new SqliteStore(":memory:", mockClock, mockIdGen);
    notifier = new ConsoleNotifier();
    mockSchedulerDeps = {
      store,
      brain: mockBrain as any,
      applier: mockApplier as any,
      channel: mockChannel as any,
      cadence: mockCadence as any,
      notifier,
      clock: mockClock as any,
      sleep: mockSleep,
    };
  });

  it("fires watchdog on state-entry-time elapsed, NOT on updated_at", async () => {
    // 1. Create order and move to mockup state.
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    // Record the exact time the order entered mockup.
    const enteredMockupAt = currentTime;
    const stateEntryTime = store.getStateEntryTime(order.order_id, "mockup");
    expect(stateEntryTime).toBeDefined();

    // 2. Simulate 12+ pings with 1-minute spacing + reassurance replies.
    // This bumps updated_at repeatedly, keeping it fresh.
    // But the order NEVER actually advances (media-send failed).
    for (let i = 0; i < 12; i++) {
      currentTime += 60_000; // advance 1 minute

      const pingEvent = store.appendEvent({
        order_id: order.order_id,
        actor: "client",
        type: "msg_recv",
        payload: { text: "?" },
      });

      // Brain replies (simulating the in-persona reassurance).
      const replyEvent = store.appendEvent({
        order_id: order.order_id,
        actor: "flock",
        type: "msg_sent",
        payload: { text: "Still generating, hang tight...", silent: false },
        inbound_event_id: pingEvent.id,
      });

      // Patch order (this would bump updated_at in a real scenario).
      store.patchOrder(order.order_id, {}); // no-op patch, but bumps updated_at

      let cur = store.getOrder(order.order_id)!;
      // After each ping, updated_at is fresh. With the bug (updated_at anchor),
      // the watchdog would never see elapsed > 2 min. With state-entry anchor, it will.
    }

    // 3. At this point:
    // - 12 minutes have elapsed since order entered mockup
    // - Order still at mockup (never advanced)
    // - updated_at is very recent (last ping was 60s ago)
    // - With updated_at anchor: elapsed since updated_at = ~60s (WATCHDOG DOESN'T FIRE — BUG)
    // - With state-entry anchor: elapsed since mockup entry = ~12min (WATCHDOG FIRES — FIX)

    const cur = store.getOrder(order.order_id)!;
    const updatedAtElapsed = currentTime - Date.parse(cur.updated_at);
    const stateEntryTime2 = store.getStateEntryTime(order.order_id, "mockup")!;
    const stateEntryElapsed = currentTime - Date.parse(stateEntryTime2);

    console.log(`\nFinal state:`);
    console.log(
      `  Elapsed from updated_at: ${Math.round(updatedAtElapsed / 1000)}s (would NOT trigger 2-min watchdog)`,
    );
    console.log(
      `  Elapsed from state entry: ${Math.round(stateEntryElapsed / 1000)}s (SHOULD trigger 2-min watchdog)`,
    );

    // 4. Run the watchdog.
    const scheduler = new Scheduler(mockSchedulerDeps);
    await (scheduler as any).watchMockupState();

    // 5. Check if escalation fired (only happens with state-entry anchor).
    const escalatedOrder = store.getOrder(order.order_id)!;
    expect(escalatedOrder.escalation).toBe("manual");
    expect(escalatedOrder.state).toBe("mockup"); // never advanced

    const spec = escalatedOrder.job_spec ? JSON.parse(escalatedOrder.job_spec) : {};
    expect(spec.mockup_failed_escalation).toBe(true);
    expect(spec.mockup_failure_type).toBe("send_failed");

    console.log(`\nWatchdog FIRED correctly after ${Math.round(stateEntryElapsed / 1000)}s in mockup (despite constant pinging).`);
  });

  it("guards against re-escalation on repeated watchdog checks", async () => {
    // Setup: order stuck at mockup, already escalated by watchdog.
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    const { escalateForMockupFailure } = await import("../src/ops/escalation.js");

    // First watchdog check escalates.
    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "send_failed",
      "Watchdog first check",
    );

    let cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");

    const eventCountAfter = store.getConversationHistory(order.order_id, 999).length;

    // Advance time, watchdog checks again, still >2min in mockup.
    currentTime += 60_000;

    // Re-running the watchdog should NOT escalate again (guard prevents it).
    await escalateForMockupFailure(
      store,
      notifier,
      order.order_id,
      "send_failed",
      "Watchdog second check",
    );

    cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");

    // Event count should NOT increase (no re-escalation event).
    const finalEventCount = store.getConversationHistory(order.order_id, 999).length;
    expect(finalEventCount).toBe(eventCountAfter);

    console.log("Re-escalation guard working: no second escalation event posted.");
  });
});
