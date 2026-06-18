// domain/types.ts
// Domain types mirror order-schema.sql 1:1. The SQL CHECK constraints are the
// authority; these unions must stay identical to them.

export type FulfillmentMethod = "pickup" | "local_delivery" | "ship";
export type ShippingTier = "standard" | "priority" | "overnight";

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
  | "forfeited"
  | "shop_rejected";

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "closed",
  "cancelled",
  "forfeited",
  "shop_rejected",
]);

// Per-element specification for the mockup layout.
// Properties split into content (locked — always sourced from assetStore / Order row)
// and layout/style (overridable per revision without re-uploading assets).
export interface ElementSpec {
  element_id: string;            // "logo_main" | "text_headline" | "product_main" | etc.
  type: "image" | "text" | "shape";
  locked: boolean;               // true for all content; false for position/size/color

  // Content — LOCKED. Compositor ignores these and always sources from:
  //   image → assetStore.resolveLogo / resolveAsset
  //   text  → order.client_name / order.business_name
  content?: string;              // text content reference only (never rendered from here)
  asset_id?: string;             // logo/image UUID reference only (never fetched from here)

  // Layout — overridable per revision
  position?: { x: number; y: number };       // fraction of canvas (0..1)
  size?: { width: number; height: number };  // fraction of canvas (0..1)

  // Style — overridable per revision
  font?: { family: string; weight: number; size_points: number };
  color?: string;    // #hex; for text elements overrides palette-derived color
  opacity?: number;  // 0..1
}

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
  // In-memory only — elements are persisted as job_spec.elements (JSON).
  // Populated by callers who deserialize job_spec for element-level operations.
  elements?: ElementSpec[];
  // Fulfillment fields (§5.12) — NULL until fulfillment step is reached
  fulfillment_method: FulfillmentMethod | null;
  delivery_address: string | null;
  shipping_tier: ShippingTier | null;
  shipping_cents: number | null;
  ready_to_ship_date: string | null; // ISO8601 agreed project date; ETA clock starts here
  // Content-gate fields
  shop_rejected_reason: string | null;
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
  specs?: {
    description?: string;
    product_type?: string;
    colors?: string[];
    qr_content?: string;
  };
  elements?: ElementSpec[];   // per-element specs; layout overrides applied at render
  theme?: string;
  style?: string;
  color_palette?: string[];
  price_cents?: number;       // client price; deposit/balance are 50% each of this
  currency?: string;          // client charge currency (default USD)
  last_brief?: string;
  mockup_urls?: { A?: string; B?: string };
  final_url?: string;
  // IP attestation: recorded when a flagged asset is attested by the client
  ip_attestation?: {
    attested_at: string;          // ISO8601
    client_confirms_rights: boolean;
    prompt_shown: string;         // exact text shown to client before attestation
  };
  // Moderation flag: set by the moderation gate on each confirm_asset attempt
  moderation_flag?: {
    flagged: boolean;
    reason?: string;
    checked_at: string;           // ISO8601
  };
  [k: string]: unknown;
}
