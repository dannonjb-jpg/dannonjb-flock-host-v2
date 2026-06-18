// store/store.ts
// The Store PORT. The host is the sole writer of orders & payments (§1, schema header).
// Only the host process constructs the concrete SqliteStore, which enforces that
// discipline physically by being the single process holding the DB handle.
//
// `transition` re-checks legality against the state machine and writes the
// state_change event atomically — even though callers (the action applier) have
// already validated, this is the last line of defence before a write.

import {
  Order,
  OrderState,
  Payment,
  PaymentKind,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
  ClientPaymentKind,
  EventRow,
  EventActor,
  EventType,
  Client,
} from "../domain/types.js";

export interface NewEvent {
  order_id: string | null;
  actor: EventActor;
  type: EventType;
  payload?: unknown; // serialized to JSON by the store
  inbound_event_id?: string | null;
}

export interface NewPayment {
  order_id: string;
  kind: PaymentKind;
  direction: PaymentDirection;
  amount_cents: number;
  currency: string;
  fx_to_usd: number | null;
  method: PaymentMethod | null;
  idempotency_key: string;
}

export interface Quote {
  quote_id: string;
  order_id: string;
  supplier_id: string;
  amount_cents: number | null;
  currency: string | null;
  turnaround_days: number | null;
  status: string;
}

/** Thrown by insertPendingPayment when the idempotency_key already exists. */
export class IdempotencyCollision extends Error {
  constructor(public key: string) {
    super(`payment idempotency_key already exists: ${key}`);
    this.name = "IdempotencyCollision";
  }
}

export interface Store {
  // ── orders ────────────────────────────────────────────────────────────
  createOrder(jid: string): Order;
  getOrder(orderId: string): Order | null;
  /** Most recent NON-TERMINAL order for a JID, or null (§6 order resolution). */
  findActiveOrderByJid(jid: string): Order | null;
  /** Generic field patch; bumps updated_at. Does NOT change `state` — use transition(). */
  patchOrder(orderId: string, patch: Partial<Order>): Order;
  /**
   * Legal state transition + state_change event, atomically. Re-validates against
   * the state machine; throws on an illegal transition (caller should have checked).
   */
  transition(orderId: string, to: OrderState, payload?: unknown): Order;

  // ── client profiles ──────────────────────────────────────────────────────────
  /** Upsert a client record for this JID. Only provided (non-undefined) fields are written on update. */
  addOrUpdateClient(jid: string, name?: string | null, business?: string | null, delivery_address?: string | null): Client;
  getClientByJid(jid: string): Client | null;
  /** All orders (any state) for this JID, newest first. */
  getClientOrders(jid: string): Order[];

  // ── payments (insert-before-charge, §7) ──────────────────────────────────
  /** Commit a `pending` row BEFORE charging. Throws IdempotencyCollision on retry. */
  insertPendingPayment(p: NewPayment): Payment;
  getPaymentByKey(key: string): Payment | null;
  getPayment(paymentId: string): Payment | null;
  markPaymentStatus(paymentId: string, status: PaymentStatus, externalRef?: string | null): Payment;
  /** Conditional update: only succeeds if current status='pending'. Returns changes count for CAS. */
  markPaymentStatusIfPending(paymentId: string, status: PaymentStatus, externalRef?: string | null): { changes: number; payment: Payment | null };
  listPayments(orderId: string): Payment[];
  /** The kind of an in-flight inbound client payment, or 'none' (for [ctx]). */
  pendingClientPaymentKind(orderId: string): ClientPaymentKind | "none";
  /** True if any succeeded inbound payment is held (not refunded) — gates cancel. */
  hasHeldMoney(orderId: string): boolean;
  /** Count of succeeded inbound `digital` payments = current block index. */
  succeededDigitalBlocks(orderId: string): number;

  // ── events (append-only) ─────────────────────────────────────────────────
  appendEvent(e: NewEvent): EventRow;
  /** Look up a single event by event_id (PK lookup). Used by intake to fetch wa_quoted from msg_recv. */
  getEvent(eventId: string): EventRow | null;
  /** §9: inbound msg_recv events that have no linked msg_sent reply. */
  findUnansweredInbound(): EventRow[];
  /** §9: payments stuck `pending` that already have an external_ref. */
  findPendingPaymentsWithExternalRef(): Payment[];
  /** Manual payment confirmation: pending inbound payments not via Stripe (Zelle/OXXO/cash). */
  listPendingManualPayments(): Payment[];
  /** True if this inbound has already been answered (a msg_sent links to it). */
  inboundHasReply(inboundEventId: string): boolean;
  /**
   * Recent conversation turns for the order, oldest-first, ready to pass to the brain.
   * Pulls from msg_recv (role=user) and non-silent msg_sent (role=assistant) events.
   * `limit` is per-role (so limit=10 gives up to 20 messages = 10 full exchanges).
   */
  getConversationHistory(orderId: string, limit?: number): import("../brain/hermes-client.js").ConversationTurn[];

  // ── quotes (read-only here; supplier agent & Penn write them) ─────────────
  getSelectedQuote(orderId: string): Quote | null;

  // ── scheduler (§8) ────────────────────────────────────────────────────────
  /**
   * Non-terminal orders that need a dormancy sweep:
   *   (a) recently gone quiet — updated_at is older than quietSinceIso, OR
   *   (b) already flagged dormant — dormant_since is set (Penn may have bumped updated_at
   *       without the client responding, which should not hide the order from the sweep).
   */
  findQuietOrders(quietSinceIso: string): Order[];
  /**
   * Set dormancy overlay fields WITHOUT bumping updated_at — the going-dark clock is
   * measured from the client's last activity, so the host's own follow-ups must not
   * reset it. A client reply (handleInbound) clears the overlay and bumps updated_at.
   */
  setDormancy(orderId: string, dormantSince: string | null, followUpStage: number): Order;

  // ── watchdog (§3 fix) ──────────────────────────────────────────────────────────
  /**
   * Find the timestamp when an order last entered a specific state (via state_change event).
   * Used by the mockup watchdog to measure time-in-state (invariant to subsequent pings/patches).
   */
  getStateEntryTime(orderId: string, state: OrderState): string | null;

  /**
   * Get all non-terminal orders. Used by watchdog to scan for stuck states (expensive, use sparingly).
   */
  getAllNonTerminalOrders(): Order[];

  /**
   * Sum of all successful DALL-E calls today (mockup_calls_paid_cents in job_spec).
   * Used by spend cap to enforce daily ceiling before accepting new mockup requests.
   */
  getDailyMockupSpendCents(todayIso: string): number;

  /**
   * Get the type of the most recent rejected action for this order (if any from the last turn).
   * Returns the action type (e.g. 'request_mockup') or null.
   * Bounded to avoid accumulation: only returns if it's from the current turn.
   */
  getLastRejectedAction(orderId: string): string | null;

}
