// payments/payment-ops.ts
// §7, encoded. The ONLY place charges are initiated. Invariants:
//   - idempotency key = {order_id}:{kind}:{discriminator}, deterministic, never random
//       discriminator: '1' for deposit/balance; block index for digital; supplier_id for supplier_deposit
//   - INSERT-BEFORE-CHARGE: commit a `pending` row (UNIQUE key) BEFORE calling the
//       provider, so a crash-and-retry re-insert fails the UNIQUE constraint and the
//       charge cannot fire twice.
//   - amounts: deposit/balance = 50% each of client price; digital = $5 per block.
//   - currency + fx_to_usd captured at payment time.
//   - manual methods clear later (Dan via Penn) — confirm() commits the success.

import { Store, IdempotencyCollision, NewPayment } from "../store/store.js";
import { Clock } from "../domain/ports.js";
import {
  Order,
  Payment,
  JobSpec,
  PaymentMethod,
  ClientPaymentKind,
} from "../domain/types.js";
import { PaymentProvider, FxSource, ChargeResult } from "./providers.js";

export class PriceUnavailable extends Error {
  constructor(public orderId: string) {
    super(`no client price on order ${orderId}; cannot compute charge`);
    this.name = "PriceUnavailable";
  }
}

const DIGITAL_BLOCK_CENTS = 500; // $5 per block
const REVISION_BLOCK_CENTS = 500; // $5 per block of 3 physical revisions (after 3 free)

export interface RequestResult {
  payment: Payment;
  /** True only if the provider cleared synchronously (e.g. Stripe). Manual => false. */
  cleared: boolean;
  /** Stripe Checkout Session URL — present when the client needs to tap a link to pay. */
  paymentUrl?: string;
}

export class PaymentOps {
  constructor(
    private store: Store,
    private provider: PaymentProvider,
    private fx: FxSource,
    private clock: Clock,
  ) {}

  private jobSpec(order: Order): JobSpec {
    if (!order.job_spec) return {};
    try {
      return JSON.parse(order.job_spec) as JobSpec;
    } catch {
      return {};
    }
  }

  /** Amount + currency for a client charge. Throws PriceUnavailable if unknown. */
  private clientCharge(order: Order, kind: ClientPaymentKind): { amount: number; currency: string } {
    const spec = this.jobSpec(order);
    const currency = spec.currency ?? "USD";
    if (kind === "digital") return { amount: DIGITAL_BLOCK_CENTS, currency };
    if (kind === "revision") return { amount: REVISION_BLOCK_CENTS, currency };
    const price = spec.price_cents;
    if (typeof price !== "number" || price <= 0) throw new PriceUnavailable(order.order_id);
    return { amount: Math.round(price * 0.5), currency }; // 50% for deposit AND balance
  }

  private discriminator(orderId: string, kind: ClientPaymentKind): string {
    if (kind === "digital") return String(this.store.succeededDigitalBlocks(orderId));
    if (kind === "revision") return String(this.store.succeededRevisionBlocks(orderId));
    // Attempt-scoped: only increment when a prior Checkout Session was actually created
    // (has external_ref) AND has since completed (failed/expired or succeeded).
    // A row without external_ref = raw API error before any session was made; retry reuses
    // the same key safely. A row with external_ref + status=pending = session still open;
    // don't increment while the client might still tap the link.
    const completedSessionAttempts = this.store
      .listPayments(orderId)
      .filter(
        (p) =>
          p.kind === kind &&
          p.direction === "in" &&
          p.external_ref !== null &&
          p.status !== "pending",
      ).length;
    return String(completedSessionAttempts + 1);
  }

  /**
   * Request a client payment. Insert-before-charge; idempotent on retry.
   * State advancement is the caller's (host) responsibility, keyed off `cleared`
   * for synchronous providers or off confirm() for manual ones.
   */
  async requestClientPayment(
    order: Order,
    kind: ClientPaymentKind,
    method: PaymentMethod,
  ): Promise<RequestResult> {
    const { amount, currency } = this.clientCharge(order, kind);
    const key = `${order.order_id}:${kind}:${this.discriminator(order.order_id, kind)}`;

    // INSERT-BEFORE-CHARGE. If a prior attempt already inserted this key, reuse it
    // rather than charging again.
    const row: NewPayment = {
      order_id: order.order_id,
      kind,
      direction: "in",
      amount_cents: amount,
      currency,
      fx_to_usd: this.fx.toUsd(currency),
      method,
      idempotency_key: key,
    };
    let payment: Payment;
    try {
      payment = this.store.insertPendingPayment(row);
    } catch (e) {
      if (e instanceof IdempotencyCollision) {
        const existing = this.store.getPaymentByKey(key);
        if (!existing) throw e;
        if (existing.status === "failed") {
          // Prior attempt failed — no money moved. Reset to pending and re-attempt.
          // Stripe's idempotency allows re-trying a failed PaymentIntent under the same key,
          // so this is safe for both sync and async providers.
          payment = this.store.markPaymentStatus(existing.payment_id, "pending", null);
          // fall through to the charge below
        } else {
          // In-flight or already settled — never fire a second charge.
          return { payment: existing, cleared: existing.status === "succeeded" };
        }
      } else {
        throw e;
      }
    }

    const result = await this.charge(payment, `Flock ${kind} for ${order.order_id}`);
    return this.applyResult(payment, result);
  }

  /** Supplier deposit (direction out). Discriminator = supplier_id. */
  async requestSupplierDeposit(
    order: Order,
    supplierId: string,
    amountCents: number,
    currency: string,
    method: PaymentMethod,
  ): Promise<RequestResult> {
    const key = `${order.order_id}:supplier_deposit:${supplierId}`;
    const row: NewPayment = {
      order_id: order.order_id,
      kind: "supplier_deposit",
      direction: "out",
      amount_cents: amountCents,
      currency,
      fx_to_usd: this.fx.toUsd(currency),
      method,
      idempotency_key: key,
    };
    let payment: Payment;
    try {
      payment = this.store.insertPendingPayment(row);
    } catch (e) {
      if (e instanceof IdempotencyCollision) {
        const existing = this.store.getPaymentByKey(key);
        if (!existing) throw e;
        return { payment: existing, cleared: existing.status === "succeeded" };
      }
      throw e;
    }
    const result = await this.charge(payment, `Supplier deposit ${supplierId} / ${order.order_id}`);
    return this.applyResult(payment, result);
  }

  /**
   * Issue a full refund for all collected (succeeded inbound) payments.
   * Idempotency key: `{order_id}:refund:shop_rejected` — safe to retry.
   * Direction is `out` (money leaving Flock back to the client).
   */
  async issueRefund(order: Order, method: PaymentMethod): Promise<RequestResult> {
    const all = this.store.listPayments(order.order_id);
    const collected = all
      .filter((p) => p.direction === "in" && p.status === "succeeded")
      .reduce((sum, p) => sum + p.amount_cents, 0);

    if (collected === 0) {
      throw new Error(`no collected payments to refund for order ${order.order_id}`);
    }

    const currency = all.find((p) => p.direction === "in")?.currency ?? "USD";
    const key = `${order.order_id}:refund:shop_rejected`;

    const row: NewPayment = {
      order_id: order.order_id,
      kind: "refund",
      direction: "out",
      amount_cents: collected,
      currency,
      fx_to_usd: this.fx.toUsd(currency),
      method,
      idempotency_key: key,
    };

    let payment: Payment;
    try {
      payment = this.store.insertPendingPayment(row);
    } catch (e) {
      if (e instanceof IdempotencyCollision) {
        const existing = this.store.getPaymentByKey(key);
        if (!existing) throw e;
        return { payment: existing, cleared: existing.status === "succeeded" };
      }
      throw e;
    }

    const result = await this.charge(payment, `Shop rejection refund for ${order.order_id}`);
    return this.applyResult(payment, result);
  }

  private async charge(payment: Payment, description: string): Promise<ChargeResult> {
    return this.provider.charge({
      amountCents: payment.amount_cents,
      currency: payment.currency,
      idempotencyKey: payment.idempotency_key,
      description,
      metadata: { order_id: payment.order_id, payment_id: payment.payment_id, kind: payment.kind },
    });
  }

  private applyResult(payment: Payment, result: ChargeResult): RequestResult {
    if (result.status === "succeeded") {
      const updated = this.store.markPaymentStatus(payment.payment_id, "succeeded", result.externalRef);
      this.store.appendEvent({
        order_id: payment.order_id,
        actor: "flock",
        type: "payment",
        payload: { payment_id: payment.payment_id, kind: payment.kind, status: "succeeded" },
      });
      return { payment: updated, cleared: true, paymentUrl: result.paymentUrl };
    }
    if (result.status === "failed") {
      const updated = this.store.markPaymentStatus(payment.payment_id, "failed", result.externalRef ?? null);
      this.store.appendEvent({
        order_id: payment.order_id,
        actor: "flock",
        type: "payment",
        payload: { payment_id: payment.payment_id, kind: payment.kind, status: "failed", error: result.error },
      });
      return { payment: updated, cleared: false };
    }
    // pending: manual method or async; record the external_ref if we got one.
    const updated = result.externalRef
      ? this.store.markPaymentStatus(payment.payment_id, "pending", result.externalRef)
      : payment;
    return { payment: updated, cleared: false, paymentUrl: result.paymentUrl };
  }

  /**
   * Confirm a previously-pending payment cleared (Dan via Penn, or Stripe webhook /
   * reconciliation). Idempotent: confirming an already-succeeded row is a no-op.
   * 
   * Uses conditional UPDATE (status='pending' guard) to ensure exactly-once semantics
   * on concurrent redelivery — only the first delivery can flip pending→succeeded.
   * 
   * MUST be called inside an outer transaction that also encompasses state transition
   * (order advancement off deposit_pending). Caller is responsible for wrapping both
   * mark + event + transition in one atomic unit.
   * 
   * Returns { won, payment } where won===true means this delivery won the race and
   * should proceed with state advance. won===false means loser (crashed delivery, concurrent
   * race) and caller should no-op.
   */
  confirmInTransaction(paymentId: string, externalRef?: string): { won: boolean; payment: Payment } {
    // CRITICAL: This method MUST be called inside an outer db.transaction() wrapper.
    // If not, the conditional UPDATE and state transition are no longer atomic,
    // and both the crash-between-mark-and-state and concurrent-race windows reopen.
    if (!(this.store as any).db.inTransaction) {
      throw new Error("confirmInTransaction() must be called inside db.transaction() wrapper — atomicity required");
    }
    
    const p = this.store.getPayment(paymentId);
    if (!p) throw new Error(`unknown payment ${paymentId}`);
    // Fast-path: already settled, no-op.
    if (p.status === "succeeded") return { won: false, payment: p };

    // Conditional update: only winner can transition pending→succeeded.
    const res = this.store.markPaymentStatusIfPending(paymentId, "succeeded", externalRef ?? p.external_ref);
    // Lost the race: another delivery already flipped this row to succeeded.
    if (res.changes === 0) return { won: false, payment: res.payment! };
    
    // Winner: append event. Caller will append state transition event in same txn.
    this.store.appendEvent({
      order_id: p.order_id,
      actor: "penn",
      type: "payment",
      payload: { payment_id: paymentId, kind: p.kind, status: "succeeded", manual_confirm: true },
    });
    return { won: true, payment: res.payment! };
  }
}
