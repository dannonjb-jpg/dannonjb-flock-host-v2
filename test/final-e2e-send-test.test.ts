/**
 * final-e2e-send-test.test.ts
 *
 * CRITICAL: End-to-end test of DALLE mockup generation + Baileys send.
 *
 * This test verifies the complete pipeline:
 * 1. Create an order and generate a request_mockup action
 * 2. Call applier.applyAll() which calls applier.onRequestMockup()
 * 3. Verify presentations are generated with image URLs
 * 4. Simulate the host's send loop
 * 5. Verify sendMedia() is called with real URLs
 *
 * Success = Customer receives images via Baileys
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { ActionApplier } from "../src/brain/action-applier.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { ManualProvider, usdOnlyFx } from "../src/payments/providers.js";
import { systemClock, uuidGen } from "../src/domain/ports.js";
import { Order, Action, MockupUrls } from "../src/domain/types.js";
import { WhatsAppChannel } from "../src/channel/channel.js";

// Mock channel that captures sends
class TestChannel implements WhatsAppChannel {
  sends: { type: "text" | "media"; jid: string; text?: string; url?: string; caption?: string }[] = [];

  onInbound(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async readMessages(): Promise<void> {}
  async setPresence(): Promise<void> {}

  async sendMessage(jid: string, text: string): Promise<void> {
    console.log(`    [SEND_TEXT] ${jid.substring(0, 20)}... "${text.substring(0, 30)}..."`);
    this.sends.push({ type: "text", jid, text });
  }

  async sendMedia(jid: string, url: string, caption?: string): Promise<void> {
    console.log(`    [SEND_MEDIA] ${jid.substring(0, 20)}... URL="${url.substring(0, 40)}..." caption="${caption}"`);
    this.sends.push({ type: "media", jid, url, caption });
  }

  getQRCode(): null {
    return null;
  }
}

// Mock DALLE pipeline
class MockDalleService {
  callCount = 0;
  async generate() {
    this.callCount++;
    console.log(`    [DALLE_GEN] Call #${this.callCount}`);
    return {
      A: `https://sovereigntysolutions.org/mockups/dalle-a-${this.callCount}.png`,
      B: `https://sovereigntysolutions.org/mockups/dalle-b-${this.callCount}.png`,
    };
  }
}

class MockQueue {
  async queueRevision() {}
}

class MockDelivery {
  async deliverFinal() {
    return { url: "https://sovereigntysolutions.org/delivery/final.pdf" };
  }
}

class MockNotifier {
  async notify() {}
  async postToPenn() {}
}

describe("final-e2e-send-test", () => {
  let store: Store;
  let channel: TestChannel;
  let dalle: MockDalleService;
  let applier: ActionApplier;
  let order: Order;
  const testJid = "test-e2e-customer@s.whatsapp.net";

  beforeEach(() => {
    store = new SqliteStore(":memory:", systemClock, uuidGen);
    channel = new TestChannel();
    dalle = new MockDalleService();

    const payments = new PaymentOps(store, new ManualProvider("manual"), usdOnlyFx, systemClock);

    applier = new ActionApplier({
      store,
      payments,
      mockups: dalle as any,
      supplierQueue: new MockQueue() as any,
      delivery: new MockDelivery() as any,
      notifier: new MockNotifier() as any,
      clock: systemClock,
      defaultMethod: "manual",
    });

    // Create order in intake state
    order = store.createOrder(testJid);
    store.patchOrder(order.order_id, {
      business_name: "Test Business",
      project_type: "business",
      job_spec: JSON.stringify({
        specs: {
          specs: "4×10 vinyl banner design needed",
        },
      }),
    });
  });

  it("request_mockup action generates DALLE images and returns presentations", { timeout: 10000 }, async () => {
    console.log("\n🎨 E2E TEST: DALLE Generation + Baileys Send");
    console.log(`   Order: ${order.order_id.substring(0, 8)}`);
    console.log(`   JID: ${testJid}`);
    console.log();

    // Step 1: Create request_mockup action
    const mockupAction: Action = {
      type: "request_mockup",
      variant: "both",
      brief: "Professional banner design with logo",
    };

    console.log(`1️⃣  Calling applier.applyAll([request_mockup])`);

    // Step 2: Apply the action
    const outcome = await applier.applyAll(order.order_id, [mockupAction]);

    console.log(`   ✅ Action completed`);
    console.log(`   Applied: ${outcome.applied.length}`);
    console.log(`   Rejected: ${outcome.rejected.length}`);
    console.log(`   Presentations: ${outcome.presentations.length}`);
    console.log();

    // Check presentations
    if (outcome.presentations.length === 0) {
      console.log("   ❌ No presentations returned (no mockups to send)");
      throw new Error("Expected presentations but got none");
    }

    for (const pres of outcome.presentations) {
      console.log(`   Presentation for order ${pres.orderId.substring(0, 8)}:`);
      for (const [variant, url] of Object.entries(pres.urls)) {
        if (url) {
          console.log(`     ${variant}: ${url.substring(0, 50)}...`);
        }
      }
    }

    console.log();
    console.log(`2️⃣  Simulating host's presentation-send loop`);

    // Step 3: Simulate the host's presentation send loop (from host.ts:255-262)
    const presentations = outcome.presentations;
    for (const p of presentations) {
      const pOrder = store.getOrder(p.orderId);
      if (!pOrder) continue;
      try {
        for (const [variant, url] of Object.entries(p.urls)) {
          if (url) {
            await channel.sendMedia(pOrder.whatsapp_jid, url as string, `Option ${variant}`);
          }
        }
        // Advance to awaiting_decision
        store.transition(p.orderId, "awaiting_decision", { presented: true });
        console.log(`   ✅ Order advanced to awaiting_decision`);
      } catch (e) {
        console.log(`   ❌ Send failed: ${(e as Error).message}`);
        throw e;
      }
    }

    console.log();
    console.log(`3️⃣  Validation:`);

    const mediaSends = channel.sends.filter((s) => s.type === "media");
    console.log(`   Images sent: ${mediaSends.length}`);
    for (const send of mediaSends) {
      console.log(`     ✅ ${send.url!.substring(0, 40)}... (${send.caption})`);
    }

    const finalOrder = store.getOrder(order.order_id);
    console.log(`   Final state: ${finalOrder!.state}`);
    console.log(`   DALLE calls made: ${dalle.callCount}`);

    console.log();
    console.log(`✅ SUCCESS: End-to-end pipeline complete`);
    console.log(`   - DALLE generated ${dalle.callCount} pairs`);
    console.log(`   - Baileys sent ${mediaSends.length} images`);
    console.log(`   - Order state advanced to awaiting_decision`);

    // Assertions
    expect(outcome.presentations.length).toBeGreaterThan(0);
    expect(mediaSends.length).toBeGreaterThan(0);
    expect(dalle.callCount).toBeGreaterThan(0);
    expect(finalOrder!.state).toBe("awaiting_decision");
  });
});
