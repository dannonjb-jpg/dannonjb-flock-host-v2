import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InboundMessage } from "../src/channel/channel.js";
import { Host, type HostDeps } from "../src/host.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import type { Clock, IdGen } from "../src/domain/ports.js";
import pino from "pino";

describe("2c-2: Image-Input Stopgap (empty text + media)", () => {
  let store: SqliteStore;
  let mockClock: Clock;
  let mockIdGen: IdGen;
  let mockBrain: any;
  let mockApplier: any;
  let mockPayments: any;
  let mockChannel: any;
  let mockCadence: any;
  let mockNotifier: any;
  let hostDeps: HostDeps;
  let host: Host;

  beforeEach(() => {
    mockClock = {
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
    };

    mockIdGen = {
      next: () => `test-id-${Math.random().toString(36).slice(2)}`,
    };

    store = new SqliteStore(":memory:", mockClock, mockIdGen);

    // Mock brain — should NOT be called for media-only messages
    mockBrain = {
      ask: vi.fn().mockResolvedValue("[silent]"),
    };

    // Mock applier
    mockApplier = {
      apply: vi.fn().mockResolvedValue(null),
    };

    // Mock payments
    mockPayments = {
      processInbound: vi.fn().mockResolvedValue(null),
    };

    // Mock channel
    mockChannel = {
      onInbound: vi.fn(),
      readMessages: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendMedia: vi.fn().mockResolvedValue(undefined),
    };

    // Mock cadence
    mockCadence = {
      readDelayMs: vi.fn().mockReturnValue(0),
      typingMs: vi.fn().mockReturnValue(100),
    };

    // Mock notifier
    mockNotifier = {
      postToPenn: vi.fn().mockResolvedValue(undefined),
      postToPennSafe: vi.fn().mockResolvedValue(undefined),
    };

    hostDeps = {
      store,
      brain: mockBrain,
      applier: mockApplier,
      payments: mockPayments,
      channel: mockChannel,
      cadence: mockCadence,
      notifier: mockNotifier,
      clock: mockClock,
      idGen: mockIdGen,
      sleep: async (ms: number) => {
        // no-op for tests
      },
      systemPrompt: "You are Flock.",
      historyLimit: 10,
      logger: pino({ level: "silent" }),
    };

    host = new Host(hostDeps);
    host.attach();
  });

  it("acks media-only message (empty text) without calling brain", async () => {
    // Simulate media-only inbound: empty text + media flag
    const mediaMsg: InboundMessage = {
      jid: "1234567890@s.whatsapp.net",
      text: "", // Empty text (media caption is empty)
      raw: { imageMessage: { url: "https://example.com/img.jpg" } } as any,
    };

    await host.handleInbound(mediaMsg);

    // Brain should NOT have been called
    expect(mockBrain.ask).not.toHaveBeenCalled();

    // Should have sent an acknowledgment or early response (not a 400 error)
    // In a real scenario, the stopgap would send a brief "got your image" response
    // For now, we're testing that the turn completes without calling the brain

    console.log("✅ Media-only message handled without brain call");
  });

  it("processes text-only message normally (calls brain)", async () => {
    const textMsg: InboundMessage = {
      jid: "1234567890@s.whatsapp.net",
      text: "I want a banner",
      raw: null as any,
    };

    // Mock brain to return a valid action
    mockBrain.ask.mockResolvedValueOnce("Got it! Let me create some designs for you.");

    await host.handleInbound(textMsg);

    // Brain SHOULD have been called
    expect(mockBrain.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "I want a banner",
      })
    );

    console.log("✅ Text message processed normally (brain called)");
  });

  it("does not escalate on media-only message", async () => {
    const mediaMsg: InboundMessage = {
      jid: "1234567890@s.whatsapp.net",
      text: "", // Empty
      raw: { imageMessage: { url: "https://example.com/img.jpg" } } as any,
    };

    await host.handleInbound(mediaMsg);

    // Check that no escalation event was logged
    const events = (store as any).db
      .prepare("SELECT * FROM events WHERE type = 'escalation'")
      .all() as any[];

    expect(events).toHaveLength(0);

    console.log("✅ No escalation on media-only message");
  });

  it("does not pollute undelivered counter with media-only message", async () => {
    const mediaMsg: InboundMessage = {
      jid: "1234567890@s.whatsapp.net",
      text: "", // Empty
      raw: { imageMessage: { url: "https://example.com/img.jpg" } } as any,
    };

    // Make notifier fail (simulating Telegram down) — should NOT matter for media-only
    mockNotifier.postToPenn.mockRejectedValueOnce(new Error("Telegram down"));

    await host.handleInbound(mediaMsg);

    // No escalation attempted, so no undelivered events
    const events = (store as any).db
      .prepare("SELECT * FROM events WHERE type = 'escalation' AND payload LIKE '%delivered%'")
      .all() as any[];

    expect(events).toHaveLength(0);

    console.log("✅ No undelivered counter pollution");
  });
});
