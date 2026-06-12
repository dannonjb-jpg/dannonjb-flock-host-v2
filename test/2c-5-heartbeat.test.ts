import { describe, it, expect, beforeEach, vi } from "vitest";
import { Heartbeat } from "../src/ops/heartbeat.js";
import type { Notifier } from "../src/domain/integrations.js";
import type { Clock } from "../src/domain/ports.js";

describe("2c-5: Heartbeat (liveness detection)", () => {
  let mockClock: Clock;
  let mockNotifier: Notifier;
  let heartbeat: Heartbeat;

  beforeEach(() => {
    mockClock = {
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
    };

    mockNotifier = {
      postToPenn: vi.fn().mockResolvedValue(undefined),
      postToPennSafe: vi.fn().mockResolvedValue(undefined),
    };

    heartbeat = new Heartbeat({
      notifier: mockNotifier,
      clock: mockClock,
      stats: () => ({
        activeOrders: 3,
        cheapTurns: 12,
        smartTurns: 8,
        lastError: undefined,
      }),
    });
  });

  it("posts heartbeat message to Penn via postToPennSafe", async () => {
    await heartbeat.beat();

    // postToPennSafe calls postToPenn internally
    expect(mockNotifier.postToPenn).toHaveBeenCalled();

    const msg = (mockNotifier.postToPenn as any).mock.calls[0][0];
    expect(msg).toContain("up");
    expect(msg).toContain("3 active orders");
    expect(msg).toContain("20 turns");
    expect(msg).toContain("40% smart"); // 8/(12+8) = 40%

    console.log("✅ Heartbeat posted to Penn");
    console.log(`   Message: ${msg}`);
  });

  it("includes last error in heartbeat if present", async () => {
    const freshNotifier = {
      postToPenn: vi.fn().mockResolvedValue(undefined),
      postToPennSafe: vi.fn().mockResolvedValue(undefined),
    };

    const hb = new Heartbeat({
      notifier: freshNotifier,
      clock: mockClock,
      stats: () => ({
        activeOrders: 1,
        cheapTurns: 0,
        smartTurns: 1,
        lastError: "Baileys connection lost",
      }),
    });

    await hb.beat();

    const msg = (freshNotifier.postToPenn as any).mock.calls[0][0];
    expect(msg).toContain("last error: Baileys connection lost");

    console.log("✅ Last error included in heartbeat");
  });

  it("handles postToPennSafe rejection gracefully (does not throw)", async () => {
    mockNotifier.postToPennSafe = vi
      .fn()
      .mockRejectedValueOnce(new Error("Telegram unavailable"));

    let threwError = false;
    try {
      await heartbeat.beat();
    } catch (e) {
      threwError = true;
    }

    expect(threwError).toBe(false);
    console.log("✅ Heartbeat handles notification failure gracefully");
  });

  it("computes turn percentages correctly", async () => {
    const freshNotifier = {
      postToPenn: vi.fn().mockResolvedValue(undefined),
      postToPennSafe: vi.fn().mockResolvedValue(undefined),
    };

    // Edge case: no turns yet
    const hb = new Heartbeat({
      notifier: freshNotifier,
      clock: mockClock,
      stats: () => ({
        activeOrders: 0,
        cheapTurns: 0,
        smartTurns: 0,
        lastError: undefined,
      }),
    });

    await hb.beat();

    const msg = (freshNotifier.postToPenn as any).mock.calls[0][0];
    expect(msg).toContain("0 turns");
    expect(msg).toContain("0% smart"); // 0/(0+0) = 0%

    console.log("✅ Heartbeat handles zero-turn edge case");
  });
});
