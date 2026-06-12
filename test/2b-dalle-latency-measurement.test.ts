/**
 * 2b-DALLE-Latency-Measurement
 *
 * Measure real DALL-E A+B generation times through the full host stack.
 * Generate N samples, calculate p99, determine watchdog threshold.
 *
 * Run with: OPENAI_API_KEY=sk-... npx vitest run 2b-dalle-latency-measurement.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { ActionApplier } from "../src/brain/action-applier.js";
import { HttpMockupPipeline } from "../src/integrations/http-integrations.js";
import { HttpSupplierQueue, HttpDelivery } from "../src/integrations/http-integrations.js";
import { ConsoleNotifier } from "../src/ops/escalation.js";
import { PaymentOps } from "../src/payments/payment-ops.js";
import { ManualProvider, usdOnlyFx } from "../src/payments/providers.js";
import { systemClock, uuidGen } from "../src/domain/ports.js";

describe("2b-DALLE-Latency-Measurement", () => {
  let store: Store;
  let applier: ActionApplier;
  const latencies: number[] = [];
  const N_SAMPLES = 10; // Measure 10 real DALL-E calls for p99

  beforeEach(() => {
    store = new SqliteStore(":memory:", systemClock, uuidGen);
    const payments = new PaymentOps(store, new ManualProvider("manual"), usdOnlyFx, systemClock);
    const notifier = new ConsoleNotifier();

    applier = new ActionApplier({
      store,
      payments,
      mockups: new HttpMockupPipeline("http://localhost:5051"),
      supplierQueue: new HttpSupplierQueue("http://localhost:5052"),
      delivery: new HttpDelivery("http://localhost:5053"),
      notifier,
      clock: systemClock,
      defaultMethod: "manual",
    });
  });

  it(`measures real DALL-E A+B latency (${N_SAMPLES} samples for p99)`, async () => {
    console.log(`\n📊 Measuring real DALL-E latencies (${N_SAMPLES} samples)...\n`);

    for (let i = 1; i <= N_SAMPLES; i++) {
      // Create a fresh order for each sample
      const order = store.createOrder(`+1-555-test-${i}`);
      store.transition(order.order_id, "mockup");

      // Measure the full request_mockup latency
      const startMs = systemClock.nowMs();

      try {
        const presentations: any[] = [];
        await applier.applyAll(order.order_id, [
          {
            type: "request_mockup",
            variant: "both",
            brief: "Test product for latency measurement",
          },
        ]);

        const elapsedMs = systemClock.nowMs() - startMs;
        latencies.push(elapsedMs);

        console.log(`Sample ${i}/${N_SAMPLES}: ${elapsedMs}ms`);
      } catch (e) {
        console.log(`Sample ${i}/${N_SAMPLES}: ERROR - ${(e as Error).message}`);
        // Don't count errors in latency list
      }

      // Small delay between requests to avoid rate limiting
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Calculate statistics
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || latencies[latencies.length - 1];
    const max = latencies[latencies.length - 1];

    console.log(`\n📈 Latency Summary (${latencies.length} samples):`);
    console.log(`p50: ${p50}ms`);
    console.log(`p95: ${p95}ms`);
    console.log(`p99: ${p99}ms (WORST CASE)`);
    console.log(`max: ${max}ms`);

    // Recommend threshold: p99 + 30s buffer
    const recommendedThresholdMs = p99 + 30_000;
    const recommendedThresholdSec = recommendedThresholdMs / 1000;

    console.log(`\n⚙️  RECOMMENDED WATCHDOG THRESHOLD:`);
    console.log(`p99 (${p99}ms) + 30s buffer = ${recommendedThresholdSec}s`);
    console.log(`Update: Scheduler.MOCKUP_TIMEOUT_MS = ${recommendedThresholdMs}`);

    expect(p99).toBeLessThan(60_000); // p99 under 60s is reasonable
  });
});
