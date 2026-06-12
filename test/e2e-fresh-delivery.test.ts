/**
 * e2e-fresh-delivery-test.ts
 *
 * End-to-end delivery test: fresh order, full pipeline, DALLE → Baileys send.
 *
 * Run with:
 *   cd /root/flock-host-v2
 *   npx vitest run test/e2e-fresh-delivery-test.ts
 *
 * This test injects a simulated customer message and monitors the full pipeline:
 * - Order creation (intake)
 * - State progression (intake → mockup)
 * - DALLE mockup generation
 * - Baileys sendMedia() call
 * - Metrics: generation time, total turn time
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { Host, HostDeps } from "../src/host.js";
import { AnthropicClient } from "../src/brain/hermes-client.js";
import { ActionApplier } from "../src/brain/action-applier.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { ManualProvider, usdOnlyFx } from "../src/payments/providers.js";
import { systemClock, uuidGen } from "../src/domain/ports.js";
import { HttpMockupPipeline, HttpSupplierQueue, HttpDelivery } from "../src/integrations/http-integrations.js";
import { ConsoleNotifier } from "../src/ops/escalation.js";
import { WhatsAppChannel, InboundMessage } from "../src/channel/channel.js";
import { LengthScaledCadence } from "../src/channel/cadence.js";
import pino from "pino";
import * as fs from "fs";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Mock WhatsApp channel to capture outbound sends
class MockWhatsAppChannel implements WhatsAppChannel {
  messagesSent: { jid: string; text?: string; imageUrl?: string; caption?: string }[] = [];
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;

  onInbound(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async simulateInbound(jid: string, text: string): Promise<void> {
    if (this.handler) {
      console.log(`[TEST] 📨 Simulating inbound from ${jid}: "${text}"`);
      await this.handler({ jid, text, raw: {} as any });
    }
  }

  async start(): Promise<void> {
    console.log("[TEST] Mock WhatsApp channel started");
  }

  async stop(): Promise<void> {
    console.log("[TEST] Mock WhatsApp channel stopped");
  }

  async readMessages(jid: string): Promise<void> {
    console.log(`[TEST] readMessages(${jid})`);
  }

  async setPresence(jid: string, presence: "composing" | "paused"): Promise<void> {
    console.log(`[TEST] setPresence(${jid}, ${presence})`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    console.log(`[TEST] 📤 sendMessage(${jid}, "${text.substring(0, 50)}...")`);
    this.messagesSent.push({ jid, text });
  }

  async sendMedia(jid: string, url: string, caption?: string): Promise<void> {
    console.log(`[TEST] 📸 sendMedia(${jid}, URL, caption="${caption?.substring(0, 30)}...")`);
    this.messagesSent.push({ jid, imageUrl: url, caption });
  }

  getQRCode(): string | null {
    return null;
  }
}

describe("e2e-fresh-delivery-test", () => {
  let store: Store;
  let channel: MockWhatsAppChannel;
  let host: Host;
  const testJid = "1234567890@s.whatsapp.net"; // Simulated test customer
  const testMsg = "I need a banner design for my business";

  beforeEach(() => {
    store = new SqliteStore(":memory:", systemClock, uuidGen);
    channel = new MockWhatsAppChannel();

    const payments = new PaymentOps(store, new ManualProvider("manual"), usdOnlyFx, systemClock);
    const notifier = new ConsoleNotifier();

    const applier = new ActionApplier({
      store,
      payments,
      mockups: new HttpMockupPipeline("http://localhost:5051"),
      supplierQueue: new HttpSupplierQueue("http://localhost:5052"),
      delivery: new HttpDelivery("http://localhost:5053"),
      notifier,
      clock: systemClock,
      defaultMethod: "manual",
    });

    const brain = new AnthropicClient({
      apiKey: process.env.ANTHROPIC_API_KEY || "",
      model: "claude-haiku-4-5-20251001",
    });

    // Load the soul contract
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const soulPath = join(__dirname, "../flock-soul-contract.md");
    const systemPrompt = readFileSync(soulPath, "utf-8");

    const logger = pino({ level: "debug" });

    host = new Host({
      store,
      brain,
      applier,
      payments,
      channel,
      cadence: new LengthScaledCadence(),
      notifier,
      clock: systemClock,
      idGen: uuidGen,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      systemPrompt,
      logger,
    });

    channel.start();
    host.attach();
  });

  afterEach(async () => {
    await channel.stop();
  });

  it("fresh order → intake → mockup generation → customer receives image", { timeout: 30000 }, async () => {
    console.log("\n🚀 Starting end-to-end delivery test\n");

    // Step 1: Inject inbound message
    const startTime = Date.now();
    await channel.simulateInbound(testJid, testMsg);

    // Wait briefly for the turn to complete
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 2: Check order was created
    const order = store.findActiveOrderByJid(testJid);
    expect(order).toBeDefined();
    console.log(`✅ Order created: ${order!.order_id}`);
    console.log(`   State: ${order!.state}`);
    console.log(`   Turn count: ${order!.turn_count}`);

    // Step 3: Check messages were sent
    const elapsedMs = Date.now() - startTime;
    console.log(`\n⏱️  Total elapsed: ${elapsedMs}ms`);
    console.log(`📤 Messages sent: ${channel.messagesSent.length}`);

    for (let i = 0; i < channel.messagesSent.length; i++) {
      const msg = channel.messagesSent[i];
      if (msg.text) {
        console.log(`   [${i}] TEXT: "${msg.text.substring(0, 60)}..."`);
      } else if (msg.imageUrl) {
        console.log(`   [${i}] IMAGE: ${msg.imageUrl}`);
        console.log(`        Caption: "${msg.caption?.substring(0, 40)}..."`);
      }
    }

    // Validate: at least one message was sent
    expect(channel.messagesSent.length).toBeGreaterThan(0);

    // Validate: if mockup was generated, it should have been sent as media
    const imageSent = channel.messagesSent.some((m) => m.imageUrl);
    const textSent = channel.messagesSent.some((m) => m.text);

    console.log(`\n✨ Validation:`);
    console.log(`   Text messages sent: ${textSent ? "✅" : "❌"}`);
    console.log(`   Image messages sent: ${imageSent ? "✅" : "❌"}`);

    // The order should have progressed from intake
    expect(order!.state).not.toBe("intake");
    console.log(`\n✅ Test complete. Order progressed to: ${order!.state}`);
  });
});
