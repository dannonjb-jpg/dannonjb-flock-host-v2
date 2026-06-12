// domain/types.ts
// Domain types mirror order-schema.sql 1:1. The SQL CHECK constraints are the
// authority; these unions must stay identical to them.

export type Track = "undecided" | "physical" | "digital";

export type OrderState =
  | "intake"
  | "mockup"
  | "awaiting_decision"
  | "deposit_pending"
  | "digital_pending"
  | "revision"
  | "balance_pending"
  | "in_production"
  | "received"
  | "delivered"
  | "closed"
  | "cancelled"
  | "forfeited";

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "closed",
  "cancelled",
  "forfeited",
]);

export type Tier = "cheap" | "smart";
export type EscalationReason = "friction" | "mockup_pairs" | "supplier" | "manual";

export type PaymentKind =
  | "deposit"
  | "balance"
  | "digital"
  | "supplier_deposit"
  | "refund";
export type PaymentDirection = "in" | "out";
export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded";
export type PaymentMethod = "stripe" | "zelle" | "oxxo" | "cash";

// pending_payment for the [ctx] header is one of the inbound client kinds, or none.
export type ClientPaymentKind = "deposit" | "balance" | "digital" | "revision";

export interface Order {
  order_id: string;
  created_at: string;
  updated_at: string;
  whatsapp_jid: string;
  client_name: string | null;
  business_name: string | null;
  project_type: string | null;
  job_spec: string | null; // JSON string
  track: Track;
  selected_mockup: "A" | "B" | null;
  state: OrderState;
  dormant_since: string | null;
  follow_up_stage: number;
  escalation: EscalationReason | null;
  dispute_flag: number; // 0 | 1
  failed_mockup_pairs: number;
  digital_rounds_used: number;
  assigned_supplier_id: string | null;
  hermes_session_id: string | null;
  turn_count: number;
  last_tier: Tier | null;
  force_tier: Tier | null;
  notes: string | null;
}

export interface Payment {
  payment_id: string;
  order_id: string;
  created_at: string;
  kind: PaymentKind;
  direction: PaymentDirection;
  amount_cents: number;
  currency: string;
  fx_to_usd: number | null;
  method: PaymentMethod | null;
  status: PaymentStatus;
  external_ref: string | null;
  idempotency_key: string;
}

export type EventActor = "flock" | "supplier" | "penn" | "client" | "system";
export type EventType =
  | "state_change"
  | "msg_sent"
  | "msg_recv"
  | "quote_recv"
  | "payment"
  | "escalation"
  | "router"
  | "brain_attempt"
  | "brain_outcome";

export interface EventRow {
  event_id: string;
  order_id: string | null;
  created_at: string;
  actor: EventActor;
  type: EventType;
  payload: string | null; // JSON
  inbound_event_id: string | null;
}

// job_spec is freeform JSON; these are the keys the host reads/writes.
export interface JobSpec {
  specs?: Record<string, unknown>;
  price_cents?: number; // client price; deposit/balance are 50% each of this
  currency?: string; // client charge currency (default USD)
  mockup_urls?: { A?: string; B?: string };
  final_url?: string;
  [k: string]: unknown;
}
