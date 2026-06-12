// ops/stripe-webhook.ts
// §15 — real-time payment confirmation via Stripe webhooks, plus manual confirm endpoints.
// Runs in the same process as the WA socket (same systemd service).
// Binds on localhost only; TLS termination is handled externally (nginx) or not needed
// for localhost-only traffic on the same box.
//
// Handler invariants:
//  - Raw body is read BEFORE any JSON parsing — signature check requires raw bytes (Stripe).
//  - All handlers are idempotent (already-succeeded rows are no-ops).
//  - Always returns 2xx to Stripe so it stops retrying; errors are logged, not surfaced.
//  - /manual/* endpoints require no auth — localhost-only binding is the access control.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import Stripe from "stripe";
import { Host } from "../host.js";
import { Store } from "../store/store.js";

export function startWebhookServer(opts: {
  port: number;
  webhookSecret?: string;   // optional — Stripe handler disabled if absent
  stripeSecretKey?: string; // optional — Stripe handler disabled if absent
  host: Host;
  store: Store;
}): void {
  const { port, webhookSecret, stripeSecretKey, host, store } = opts;
  const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/stripe/webhook") {
        await handleStripeWebhook(req, res, stripe, webhookSecret, host, store);
      } else if (req.method === "POST" && req.url === "/manual/confirm") {
        await handleManualConfirm(req, res, host);
      } else if (req.method === "GET" && req.url === "/manual/pending") {
        handleManualPending(res, store);
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      console.error("[webhook] unhandled error:", (e as Error).message);
      res.writeHead(500).end("internal error");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const stripeActive = stripe && webhookSecret ? " + Stripe webhook" : "";
    console.log(`[webhook] admin server on 127.0.0.1:${port}${stripeActive}`);
  });
}

async function handleStripeWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  stripe: Stripe | null,
  webhookSecret: string | undefined,
  host: Host,
  store: Store,
): Promise<void> {
  if (!stripe || !webhookSecret) {
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
    await handleStripeEvent(event, host, store);
    res.writeHead(200).end("ok");
  } catch (e) {
    // Log but still return 2xx so Stripe stops retrying this event.
    // The periodic reconcile fallback will catch any missed state transitions.
    console.error("[webhook] handler error:", (e as Error).message);
    res.writeHead(200).end("logged");
  }
}

/**
 * POST /manual/confirm
 * Body: { payment_id: string, external_ref?: string }
 * Dan runs this after confirming Zelle/OXXO receipt. Calls onPaymentConfirmed which
 * atomically marks the payment succeeded and advances the order state.
 * Localhost-only binding is the access control — no auth header required.
 */
async function handleManualConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  host: Host,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: { payment_id?: string; external_ref?: string };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
  } catch {
    res.writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
    return;
  }
  if (!body.payment_id) {
    res.writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: false, error: "payment_id required" }));
    return;
  }
  await host.onPaymentConfirmed(body.payment_id, body.external_ref);
  console.log(`[manual-confirm] payment ${body.payment_id} confirmed by Dan (ref: ${body.external_ref ?? "none"})`);
  res.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ ok: true, payment_id: body.payment_id }));
}

/**
 * GET /manual/pending
 * Lists pending inbound payments that arrived via a manual method (Zelle/OXXO/cash).
 * Dan uses this to see what still needs confirming.
 */
function handleManualPending(res: ServerResponse, store: Store): void {
  const payments = store.listPendingManualPayments();
  res.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ payments }));
}

async function handleStripeEvent(event: Stripe.Event, host: Host, store: Store): Promise<void> {
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
