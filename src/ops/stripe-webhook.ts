// ops/stripe-webhook.ts
// §15 — real-time payment confirmation via Stripe webhooks.
// Runs in the same process as the WA socket (same systemd service).
// Binds on localhost only; TLS termination is handled externally (nginx) or not needed
// for localhost-only traffic on the same box.
//
// Handler invariants:
//  - Raw body is read BEFORE any JSON parsing — signature check requires raw bytes.
//  - All handlers are idempotent (already-succeeded rows are no-ops).
//  - Always returns 2xx to Stripe so it stops retrying; errors are logged, not surfaced.

import { createServer } from "node:http";
import Stripe from "stripe";
import { Host } from "../host.js";
import { Store } from "../store/store.js";

export function startWebhookServer(opts: {
  port: number;
  webhookSecret: string;
  stripeSecretKey: string;
  host: Host;
  store: Store;
}): void {
  const { port, webhookSecret, stripeSecretKey, host, store } = opts;
  const stripe = new Stripe(stripeSecretKey);

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/stripe/webhook") {
      res.writeHead(404).end();
      return;
    }

    // Read raw body — must come before any body parsing.
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);

    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      res.writeHead(400).end("missing stripe-signature header");
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (e) {
      console.error("[webhook] signature verification failed:", (e as Error).message);
      res.writeHead(400).end("signature mismatch");
      return;
    }

    try {
      await handleEvent(event, host, store);
      res.writeHead(200).end("ok");
    } catch (e) {
      // Log but still return 2xx so Stripe stops retrying this event.
      // The periodic reconcile fallback will catch any missed state transitions.
      console.error("[webhook] handler error:", (e as Error).message);
      res.writeHead(200).end("logged");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[webhook] Stripe endpoint listening on 127.0.0.1:${port}/stripe/webhook`);
  });
}

async function handleEvent(event: Stripe.Event, host: Host, store: Store): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== "paid") break; // bank transfers may be 'unpaid' initially
      const paymentId = session.metadata?.payment_id;
      if (!paymentId) {
        console.warn("[webhook] checkout.session.completed: no payment_id in metadata — skipping");
        break;
      }
      console.log(`[webhook] deposit confirmed for payment ${paymentId}`);
      await host.onPaymentConfirmed(paymentId, session.id);
      break;
    }

    case "checkout.session.expired": {
      // Session expired unpaid. Mark the payment row failed so the next re-issuance
      // attempt uses a fresh discriminator (attempt-scoped key — see payment-ops.ts).
      const session = event.data.object as Stripe.Checkout.Session;
      const paymentId = session.metadata?.payment_id;
      if (!paymentId) break;
      const p = store.getPayment(paymentId);
      if (p && p.status === "pending") {
        store.markPaymentStatus(paymentId, "failed", session.id);
        console.log(`[webhook] session expired for payment ${paymentId} — marked failed for re-issuance`);
      }
      break;
    }

    default:
      // Ignore unhandled event types — Stripe sends many; we only need these two.
      break;
  }
}
