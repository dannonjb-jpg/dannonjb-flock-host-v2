// integrations/http-integrations.ts
// Thin webhook adapters for the integrations built elsewhere (§12). Uses global fetch
// (no SDK), so it is part of the verifiable core. If an endpoint is unconfigured the
// adapter throws a clear error rather than silently no-op'ing — a stalled order beats a
// fake "done".

import { MockupPipeline, SupplierQueue, Delivery, MockupUrls } from "../domain/integrations.js";
import { Order } from "../domain/types.js";

async function postJson<T>(url: string | undefined, label: string, body: unknown): Promise<T> {
  if (!url) throw new Error(`${label} endpoint not configured`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s for gpt-image-1 latency
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class HttpMockupPipeline implements MockupPipeline {
  constructor(private url?: string) {}
  generate(order: Order, variant: "A" | "B" | "both", brief: string): Promise<MockupUrls> {
    return postJson<MockupUrls>(this.url, "mockup pipeline", {
      order_id: order.order_id,
      variant,
      brief,
      job_spec: order.job_spec,
    });
  }
}

export class HttpSupplierQueue implements SupplierQueue {
  constructor(private url?: string) {}
  async queueRevision(order: Order, note: string): Promise<void> {
    await postJson<unknown>(this.url, "supplier queue", { order_id: order.order_id, note });
  }
}

export class HttpDelivery implements Delivery {
  constructor(private url?: string) {}
  deliverFinal(order: Order): Promise<{ url: string }> {
    return postJson<{ url: string }>(this.url, "delivery", {
      order_id: order.order_id,
      job_spec: order.job_spec,
    });
  }
}
