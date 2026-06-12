/**
 * 2a-5: Watchdog hang (the ~2-min backstop)
 *
 * Prove the watchdog catches orders stuck at mockup for 2+ minutes.
 * This is the case Gate 1a can't catch (bridge accepts but never responds).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { Scheduler } from "../src/ops/scheduler.js";
import { ConsoleNotifier } from "../src/ops/escalation.js";
import { Clock, IdGen } from "../src/domain/ports.js";

describe("2a-5: Watchdog hang (state-entry time proof)", () => {
  let store: Store;
  let notifier: ConsoleNotifier;
  let currentTime = Date.now();

  const mockClock: Clock = {
    nowMs: () => currentTime,
    nowIso: () => new Date(currentTime).toISOString(),
  };

  const mockIdGen: IdGen = {
    next: () => `test-id-${Math.random().toString(36).slice(2)}`,
  };

  const mockSchedulerDeps = {
    store,
    brain: {} as any,
    applier: {} as any,
    channel: {} as any,
    cadence: {} as any,
    notifier,
    clock: mockClock,
    sleep: () => Promise.resolve(),
  };

  beforeEach(() => {
    currentTime = Date.now();
    store = new SqliteStore(":memory:", mockClock, mockIdGen);
    notifier = new ConsoleNotifier();
    mockSchedulerDeps.store = store;
    mockSchedulerDeps.notifier = notifier;
  });

  it("watchdog fires after 2 min in mockup state (state-entry anchor)", async () => {
    // 1. Create order stuck at mockup (simulating a wedged generate call).
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    const stateEntryTime = store.getStateEntryTime(order.order_id, "mockup");
    expect(stateEntryTime).toBeDefined();

    console.log(`Order at mockup, state-entry: ${stateEntryTime}`);

    // 2. Advance time 120+ seconds (past the 2-min threshold).
    currentTime += 121_000; // 121 seconds

    // 3. Run the watchdog.
    const scheduler = new Scheduler(mockSchedulerDeps as any);
    console.log(`\nTime advanced to ${Math.round((currentTime - Date.parse(stateEntryTime!)) / 1000)}s in state.`);
    console.log(`Running watchdog...`);

    await scheduler.watchMockupState();

    // 4. Verify escalation fired.
    const cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBe("manual");

    const spec = JSON.parse(cur.job_spec || "{}");
    expect(spec.mockup_failed_escalation).toBe(true);
    expect(spec.mockup_failure_type).toBe("send_failed"); // watchdog uses send_failed detail

    console.log(`\n✓ 2a-5 ACCEPT: watchdog fired after ~2 min, escalation set, order parked`);
  });

  it("watchdog does NOT fire before threshold", async () => {
    // Confirm watchdog doesn't false-positive under the threshold.
    const order = store.createOrder("+1-555-1234");
    store.transition(order.order_id, "mockup");

    // Advance time only 60 seconds (under 2-min threshold).
    currentTime += 60_000;

    const scheduler = new Scheduler(mockSchedulerDeps as any);
    await scheduler.watchMockupState();

    const cur = store.getOrder(order.order_id)!;
    expect(cur.escalation).toBeNull(); // no escalation yet

    console.log(`\n✓ 2a-5 ACCEPT: watchdog did not fire under threshold (60s < 120s)`);
  });
});
