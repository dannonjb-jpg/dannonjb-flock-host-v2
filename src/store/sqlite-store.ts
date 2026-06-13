// store/sqlite-store.ts
// Concrete Store over better-sqlite3 (WAL). The host process is the only thing that
// constructs this, which is what physically enforces single-writer discipline on
// orders & payments (§1). Excluded from the offline typecheck (imports the SDK).

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Store,
  NewEvent,
  NewPayment,
  Quote,
  IdempotencyCollision,
} from "./store.js";
import { Clock, IdGen } from "../domain/ports.js";
import {
  Order,
  OrderState,
  Payment,
  PaymentStatus,
  EventRow,
  ClientPaymentKind,
  TERMINAL_STATES,
} from "../domain/types.js";
import { assertTransition } from "../domain/state-machine.js";

const TERMINAL = [...TERMINAL_STATES];

// Columns patchOrder is allowed to write (no updated_at — set automatically).
const PATCHABLE: ReadonlyArray<keyof Order> = [
  "client_name",
  "business_name",
  "project_type",
  "job_spec",
  "track",
  "selected_mockup",
  "dormant_since",
  "follow_up_stage",
  "escalation",
  "dispute_flag",
  "failed_mockup_pairs",
  "digital_rounds_used",
  "assigned_supplier_id",
  "hermes_session_id",
  "turn_count",
  "last_tier",
  "force_tier",
  "notes",
];

export class SqliteStore implements Store {
  public db: Database.Database;

  constructor(
    dbPath: string,
    private clock: Clock,
    private idGen: IdGen,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const schema = readFileSync(fileURLToPath(new URL("./order-schema.sql", import.meta.url)), "utf8");
    this.db.exec(schema);
  }

  // ── orders ────────────────────────────────────────────────────────────
  createOrder(jid: string): Order {
    const now = this.clock.nowIso();
    const id = this.idGen.next();
    this.db
      .prepare(
        `INSERT INTO orders (order_id, created_at, updated_at, whatsapp_jid, state, track)
         VALUES (?, ?, ?, ?, 'intake', 'undecided')`,
      )
      .run(id, now, now, jid);
    return this.getOrder(id)!;
  }

  getOrder(orderId: string): Order | null {
    return (this.db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId) as Order) ?? null;
  }

  findActiveOrderByJid(jid: string): Order | null {
    const placeholders = TERMINAL.map(() => "?").join(",");
    return (
      (this.db
        .prepare(
          `SELECT * FROM orders WHERE whatsapp_jid = ? AND state NOT IN (${placeholders})
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(jid, ...TERMINAL) as Order) ?? null
    );
  }

  patchOrder(orderId: string, patch: Partial<Order>): Order {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const key of PATCHABLE) {
      if (key in patch) {
        cols.push(`${key} = ?`);
        vals.push((patch as Record<string, unknown>)[key as string] ?? null);
      }
    }
    cols.push(`updated_at = ?`);
    vals.push(this.clock.nowIso());
    vals.push(orderId);
    this.db.prepare(`UPDATE orders SET ${cols.join(", ")} WHERE order_id = ?`).run(...(vals as never[]));
    return this.getOrder(orderId)!;
  }

  transition(orderId: string, to: OrderState, payload?: unknown): Order {
    const tx = this.db.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) throw new Error(`unknown order ${orderId}`);
      assertTransition(order.state, to); // last line of defence
      const now = this.clock.nowIso();
      this.db.prepare(`UPDATE orders SET state = ?, updated_at = ? WHERE order_id = ?`).run(to, now, orderId);
      this.insertEvent({
        order_id: orderId,
        actor: "flock",
        type: "state_change",
        payload: { from: order.state, to, ...(payload && typeof payload === "object" ? payload : {}) },
      });
    });
    tx();
    return this.getOrder(orderId)!;
  }

  // ── payments ────────────────────────────────────────────────────────────
  insertPendingPayment(p: NewPayment): Payment {
    const id = this.idGen.next();
    const now = this.clock.nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO payments
             (payment_id, order_id, created_at, kind, direction, amount_cents, currency,
              fx_to_usd, method, status, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(id, p.order_id, now, p.kind, p.direction, p.amount_cents, p.currency, p.fx_to_usd, p.method, p.idempotency_key);
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.code === "SQLITE_CONSTRAINT") {
        throw new IdempotencyCollision(p.idempotency_key);
      }
      throw e;
    }
    return this.getPayment(id)!;
  }

  getPaymentByKey(key: string): Payment | null {
    return (this.db.prepare(`SELECT * FROM payments WHERE idempotency_key = ?`).get(key) as Payment) ?? null;
  }
  getPayment(paymentId: string): Payment | null {
    return (this.db.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(paymentId) as Payment) ?? null;
  }

  markPaymentStatus(paymentId: string, status: PaymentStatus, externalRef?: string | null): Payment {
    if (externalRef === undefined) {
      this.db.prepare(`UPDATE payments SET status = ? WHERE payment_id = ?`).run(status, paymentId);
    } else {
      this.db
        .prepare(`UPDATE payments SET status = ?, external_ref = ? WHERE payment_id = ?`)
        .run(status, externalRef, paymentId);
    }
    return this.getPayment(paymentId)!;
  }

  markPaymentStatusIfPending(paymentId: string, status: PaymentStatus, externalRef?: string | null): { changes: number; payment: Payment | null } {
    let info: Database.RunResult;
    if (externalRef === undefined) {
      info = this.db.prepare(`UPDATE payments SET status = ? WHERE payment_id = ? AND status = 'pending'`).run(status, paymentId);
    } else {
      info = this.db
        .prepare(`UPDATE payments SET status = ?, external_ref = ? WHERE payment_id = ? AND status = 'pending'`)
        .run(status, externalRef, paymentId);
    }
    return { changes: info.changes, payment: this.getPayment(paymentId) };
  }

  listPayments(orderId: string): Payment[] {
    return this.db.prepare(`SELECT * FROM payments WHERE order_id = ?`).all(orderId) as Payment[];
  }

  pendingClientPaymentKind(orderId: string): ClientPaymentKind | "none" {
    const row = this.db
      .prepare(
        `SELECT kind FROM payments
         WHERE order_id = ? AND direction = 'in' AND status = 'pending'
           AND kind IN ('deposit','balance','digital') LIMIT 1`,
      )
      .get(orderId) as { kind: ClientPaymentKind } | undefined;
    return row?.kind ?? "none";
  }

  hasHeldMoney(orderId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM payments WHERE order_id = ? AND direction = 'in' AND status = 'succeeded' LIMIT 1`,
      )
      .get(orderId);
    return !!row;
  }

  succeededDigitalBlocks(orderId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM payments
         WHERE order_id = ? AND kind = 'digital' AND direction = 'in' AND status = 'succeeded'`,
      )
      .get(orderId) as { n: number };
    return row.n;
  }

  succeededRevisionBlocks(orderId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM payments
         WHERE order_id = ? AND kind = 'revision' AND direction = 'in' AND status = 'succeeded'`,
      )
      .get(orderId) as { n: number };
    return row.n;
  }

  appliedRevisions(orderId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT inbound_event_id) AS n FROM events
         WHERE order_id = ? AND type = 'revision'`,
      )
      .get(orderId) as { n: number };
    return row.n;
  }

  recordRevisionEvent(orderId: string, inboundEventId: string): void {
    // Dedup: only insert if not already recorded for this inbound
    const seen = this.db
      .prepare(
        `SELECT 1 FROM events WHERE order_id = ? AND type = 'revision' AND inbound_event_id = ?`,
      )
      .get(orderId, inboundEventId);
    if (!seen) {
      this.appendEvent({
        order_id: orderId,
        actor: "client",
        type: "revision",
        inbound_event_id: inboundEventId,
      });
    }
  }

  // ── events ────────────────────────────────────────────────────────────
  private insertEvent(e: NewEvent): EventRow {
    const id = this.idGen.next();
    const now = this.clock.nowIso();
    this.db
      .prepare(
        `INSERT INTO events (event_id, order_id, created_at, actor, type, payload, inbound_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        e.order_id,
        now,
        e.actor,
        e.type,
        e.payload === undefined ? null : JSON.stringify(e.payload),
        e.inbound_event_id ?? null,
      );
    return this.db.prepare(`SELECT * FROM events WHERE event_id = ?`).get(id) as EventRow;
  }
  appendEvent(e: NewEvent): EventRow {
    return this.insertEvent(e);
  }

  getEvent(eventId: string): EventRow | null {
    return (this.db
      .prepare(`SELECT * FROM events WHERE event_id = ? LIMIT 1`)
      .get(eventId) as EventRow | undefined) ?? null;
  }

  findUnansweredInbound(): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM events ev
         WHERE ev.type = 'msg_recv'
           AND NOT EXISTS (
             SELECT 1 FROM events r WHERE r.type = 'msg_sent' AND r.inbound_event_id = ev.event_id
           )
         ORDER BY ev.created_at ASC`,
      )
      .all() as EventRow[];
  }

  findPendingPaymentsWithExternalRef(): Payment[] {
    return this.db
      .prepare(`SELECT * FROM payments WHERE status = 'pending' AND external_ref IS NOT NULL`)
      .all() as Payment[];
  }

  listPendingManualPayments(): Payment[] {
    return this.db
      .prepare(
        `SELECT * FROM payments
         WHERE status = 'pending' AND direction = 'in'
           AND method IS NOT NULL AND method != 'stripe'
         ORDER BY created_at`,
      )
      .all() as Payment[];
  }

  inboundHasReply(inboundEventId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM events WHERE type = 'msg_sent' AND inbound_event_id = ? LIMIT 1`)
      .get(inboundEventId);
    return !!row;
  }

  getConversationHistory(orderId: string, limit = 10): { role: "user" | "assistant"; content: string }[] {
    // Fetch recent msg_recv + non-silent msg_sent events, reconstruct turn pairs.
    const rows = this.db
      .prepare(
        `SELECT type, payload, created_at FROM events
         WHERE order_id = ? AND type IN ('msg_recv','msg_sent')
         ORDER BY created_at ASC`,
      )
      .all(orderId) as { type: string; payload: string | null; created_at: string }[];

    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const row of rows) {
      try {
        const p = row.payload ? (JSON.parse(row.payload) as { text?: string; silent?: boolean }) : {};
        if (row.type === "msg_recv" && p.text) {
          turns.push({ role: "user", content: p.text });
        } else if (row.type === "msg_sent" && !p.silent && p.text) {
          turns.push({ role: "assistant", content: p.text });
        }
      } catch { /* skip corrupt events */ }
    }
    // Return the most recent `limit * 2` messages (limit exchanges).
    return turns.slice(-(limit * 2));
  }

  // ── quotes ────────────────────────────────────────────────────────────
  getSelectedQuote(orderId: string): Quote | null {
    return (
      (this.db
        .prepare(
          `SELECT quote_id, order_id, supplier_id, amount_cents, currency, turnaround_days, status
           FROM quotes WHERE order_id = ? AND status = 'selected' LIMIT 1`,
        )
        .get(orderId) as Quote) ?? null
    );
  }

  // ── scheduler ────────────────────────────────────────────────────────────
  findQuietOrders(quietSinceIso: string): Order[] {
    const placeholders = TERMINAL.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM orders
         WHERE state NOT IN (${placeholders})
           AND (updated_at <= ? OR dormant_since IS NOT NULL)
           AND whatsapp_jid != 'status@broadcast'
           AND whatsapp_jid NOT LIKE '%@g.us'
         ORDER BY updated_at ASC`,
      )
      .all(...TERMINAL, quietSinceIso) as Order[];
  }

  setDormancy(orderId: string, dormantSince: string | null, followUpStage: number): Order {
    this.db
      .prepare(`UPDATE orders SET dormant_since = ?, follow_up_stage = ? WHERE order_id = ?`)
      .run(dormantSince, followUpStage, orderId);
    return this.getOrder(orderId)!;
  }

  getStateEntryTime(orderId: string, state: OrderState): string | null {
    // Find the most recent state_change event where the order transitioned TO this state.
    const row = this.db
      .prepare(
        `SELECT created_at FROM events
         WHERE order_id = ? AND type = 'state_change' AND payload LIKE ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(orderId, `%"to":"${state}"%`) as { created_at: string } | undefined;

    return row ? row.created_at : null;
  }

  getAllNonTerminalOrders(): Order[] {
    const TERMINAL = ["completed", "abandoned", "refunded", "forfeited"];
    const rows = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE state NOT IN (${TERMINAL.map(() => "?").join(",")})
         ORDER BY created_at DESC`
      )
      .all(...TERMINAL) as Order[];

    return rows;
  }

  getDailyMockupSpendCents(todayIso: string): number {
    // Sum mockup_calls_paid_cents from all orders updated today.
    // job_spec is JSON string; extract the cost field.
    const todayStart = todayIso.substring(0, 10); // "2026-06-09"

    const rows = this.db
      .prepare(
        `SELECT job_spec FROM orders
         WHERE DATE(updated_at) = ?
         AND job_spec IS NOT NULL`
      )
      .all(todayStart) as { job_spec: string }[];

    let totalCents = 0;
    for (const row of rows) {
      try {
        const spec = JSON.parse(row.job_spec) as { mockup_calls_paid_cents?: number };
        totalCents += spec.mockup_calls_paid_cents ?? 0;
      } catch {
        // Skip malformed JSON
      }
    }

    return totalCents;
  }

  // ── observability queries ────────────────────────────────────────────────
  // Read-only queries for the heartbeat and observability layer.

  /** Count non-terminal orders grouped by state. **/
  countByState(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM orders
         WHERE state NOT IN (${TERMINAL.map(() => "?").join(",")})
         GROUP BY state`
      )
      .all(...TERMINAL) as { state: string; n: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.state] = row.n;
    }
    return result;
  }

  /** Count router turns by tier since a given timestamp. **/
  routerSplitSince(sinceIso: string): { cheap: number; smart: number } {
    const rows = this.db
      .prepare(
        `SELECT json_extract(payload, '$.tier') AS tier, COUNT(*) AS n
         FROM events
         WHERE type = 'router' AND created_at >= ?
         GROUP BY tier`
      )
      .all(sinceIso) as { tier: string; n: number }[];
    let cheap = 0, smart = 0;
    for (const row of rows) {
      if (row.tier === "cheap") cheap = row.n;
      else if (row.tier === "smart") smart = row.n;
    }
    return { cheap, smart };
  }

  /** Count latest escalation events per order that have delivered=false. **/
  undeliveredEscalations(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT json_extract(payload, '$.delivered') AS d,
                  ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY created_at DESC) AS rn
           FROM events WHERE type = 'escalation'
         )
         WHERE rn = 1 AND d = 0`
      )
      .get() as { n: number };
    return row.n;
  }

  getLastRejectedAction(orderId: string): string | null {
    const order = this.getOrder(orderId);
    if (!order) return null;

    // Look for the most recent state_change event with rejected_action payload.
    // Only return if it's from the current turn to avoid accumulation.
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.rejected_action.type') AS action_type
         FROM events
         WHERE order_id = ? AND type = 'state_change' AND payload LIKE '%rejected_action%'
         AND json_extract(payload, '$.rejected_action.type') IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(orderId) as { action_type: string } | undefined;

    if (!row || !row.action_type) return null;
    return row.action_type;
  }

  close(): void {
    this.db.close();
  }
}
