// ops/shop-reject.ts
// Operator-triggered shop rejection: transition to shop_rejected, issue full refund,
// notify Penn. Called by Dan (via Penn command or CLI) when a submitted order
// cannot be fulfilled for content/policy reasons.

import { Store } from "../store/store.js";
import { PaymentOps } from "../payments/payment-ops.js";
import { Notifier } from "../domain/integrations.js";
import { isTerminal } from "../domain/state-machine.js";
import { PaymentMethod } from "../domain/types.js";

/**
 * Reject an order for shop/content reasons.
 *   - Transitions to `shop_rejected` (terminal).
 *   - Records the reason in `shop_rejected_reason`.
 *   - Issues a full refund if any money was collected (idempotent key).
 *   - Posts a Penn notification for the audit log.
 *
 * Safe to retry: the transition throws on a second call (already terminal),
 * and the refund idempotency key prevents double-refunds.
 */
export async function shopRejectOrder(
  store: Store,
  payments: PaymentOps,
  notifier: Notifier,
  orderId: string,
  reason: string,
  refundMethod: PaymentMethod = "stripe",
): Promise<void> {
  const order = store.getOrder(orderId);
  if (!order) throw new Error(`order ${orderId} not found`);
  if (isTerminal(order.state)) {
    throw new Error(`order ${orderId} is already terminal (${order.state}) — cannot reject`);
  }

  // Transition first so the audit trail is clean even if refund fails.
  store.transition(orderId, "shop_rejected", { reason });
  store.patchOrder(orderId, { shop_rejected_reason: reason });

  // Refund any collected money.
  if (store.hasHeldMoney(orderId)) {
    const fresh = store.getOrder(orderId)!;
    try {
      await payments.issueRefund(fresh, refundMethod);
    } catch (err) {
      // Log but do not re-throw: the rejection is committed; refund can be retried.
      console.error(`[shop-reject] refund failed for ${orderId}: ${(err as Error).message}`);
    }
  }

  await notifier
    .postToPenn(`[shop_rejected] ${orderId}: ${reason}`)
    .catch(() => {/* non-blocking */});
}
