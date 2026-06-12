// domain/integrations.ts
// Side-effect collaborators the host triggers but does not implement (§12: built
// elsewhere). Modeled as ports so the core stays testable; real adapters wire them.

import { Order } from "./types.js";

export interface MockupUrls {
  A?: string;
  B?: string;
}

/** Mockup GENERATION is external (§12). The host invokes it and stores the URLs. */
export interface MockupPipeline {
  generate(order: Order, variant: "A" | "B" | "both", brief: string): Promise<MockupUrls>;
}

/** Physical revisions are handed to the Supplier Agent (§5 revision_note). */
export interface SupplierQueue {
  queueRevision(order: Order, note: string): Promise<void>;
}

/** Digital delivery of the final file (§5 digital_complete). */
export interface Delivery {
  deliverFinal(order: Order): Promise<{ url: string }>;
}

/** Escalations + dormancy/heartbeat posts go to Penn's Telegram (§11). */
export interface Notifier {
  postToPenn(text: string): Promise<void>;
}
