// ops/reconcile.ts
// §9 — run ONCE on boot, before accepting new traffic. The events table is the source
// of truth for "what have I already done?" — never logs, never guesses.
//
//   1. Unanswered inbound (msg_recv with no linked msg_sent) -> replay through the host,
//      linking the reply to the ORIGINAL inbound event so it can't loop next restart.
//   2. Payments stuck `pending` that carry an external_ref -> ask the provider for the
//      settled status and reconcile (confirm advances state via host.onPaymentConfirmed).
//   3. Already-answered inbound is never resent (the query excludes it).

import { Store } from "../store/store.js";
import { Host } from "../host.js";
import { PaymentProvider } from "../payments/providers.js";

export interface ReconcileResult {
  replayedInbound: number;
  settledPayments: number;
  failedPayments: number;
}

export async function reconcile(deps: {
  store: Store;
  host: Host;
  provider: PaymentProvider;
}): Promise<ReconcileResult> {
  const { store, host, provider } = deps;
  const result: ReconcileResult = { replayedInbound: 0, settledPayments: 0, failedPayments: 0 };

  // 1. Replay unanswered inbound.
  for (const ev of store.findUnansweredInbound()) {
    if (!ev.order_id) continue;
    const order = store.getOrder(ev.order_id);
    if (!order) continue;
    let text = "";
    try {
      const payload = ev.payload ? (JSON.parse(ev.payload) as { text?: string }) : {};
      text = payload.text ?? "";
    } catch {
      /* tolerate corrupt payload; replay with empty text */
    }
    await host.handleInbound(
      { jid: order.whatsapp_jid, text },
      { replayInboundEventId: ev.event_id },
    );
    result.replayedInbound++;
  }

  // 2. Settle pending payments that have an external_ref.
  if (provider.getStatus) {
    for (const p of store.findPendingPaymentsWithExternalRef()) {
      if (!p.external_ref) continue;
      const status = await provider.getStatus(p.external_ref);
      if (status === "succeeded") {
        await host.onPaymentConfirmed(p.payment_id, p.external_ref);
        result.settledPayments++;
      } else if (status === "failed") {
        store.markPaymentStatus(p.payment_id, "failed", p.external_ref);
        result.failedPayments++;
      }
      // pending: leave as-is; a later sweep or webhook resolves it.
    }
  }

  return result;
}
