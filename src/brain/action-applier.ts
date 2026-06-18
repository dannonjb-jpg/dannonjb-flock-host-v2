// brain/action-applier.ts
// THE CORE of "the brain proposes, the host disposes." Each proposed intent is
// validated against the state machine (§6) and authorization rules (§5) and either
// committed (with events) or rejected+logged. Never trusts an intent blindly.
//
// Processed in emission order; the order is re-read between actions because earlier
// actions advance state (e.g. SOUL's select_mockup + set_track + request_payment).

import { Store } from "../store/store.js";
import { AssetStore, coarseUsable } from "../store/asset-store.js";
import { moderateAsset } from "../moderation/moderate.js";
import { Clock } from "../domain/ports.js";
import { canTransition, isTerminal } from "../domain/state-machine.js";
import { Order, JobSpec, PaymentMethod } from "../domain/types.js";
import { Action } from "./actions.js";
import {
  MockupPipeline,
  SupplierQueue,
  Delivery,
  Notifier,
} from "../domain/integrations.js";
import { PaymentOps, PriceUnavailable } from "../payments/payment-ops.js";
import { computePrice, PricingInputs } from "../pricing/pricing.js";
import { escalateForMockupFailure } from "../ops/escalation.js";

export interface ApplyDeps {
  store: Store;
  payments: PaymentOps;
  mockups: MockupPipeline;
  supplierQueue: SupplierQueue;
  delivery: Delivery;
  notifier: Notifier;
  clock: Clock;
  /** Default method for client charges (Stripe in prod; manual in some markets). */
  defaultMethod: PaymentMethod;
  assetStore: AssetStore; // For logo validation in Phase B gate
}

export interface Rejection {
  action: Action;
  reason: string;
}

export interface ApplyOutcome {
  applied: Action[];
  rejected: Rejection[];
  paymentUrls?: { kind: string; url: string }[];
  presentations?: { orderId: string; urls: { A?: string; B?: string } }[];
}

const MOCKUP_PAIR_LIMIT = 4;

function readSpec(order: Order): JobSpec {
  if (!order.job_spec) return {};
  try {
    return JSON.parse(order.job_spec) as JobSpec;
  } catch {
    return {};
  }
}

export class ActionApplier {
  private inboundEventId: string = '';
  constructor(private d: ApplyDeps) {}

  async applyAll(orderId: string, actions: Action[], inboundEventId: string): Promise<ApplyOutcome> {
    this.inboundEventId = inboundEventId;
    const applied: Action[] = [];
    const rejected: Rejection[] = [];
    const presentations: { orderId: string; urls: { A?: string; B?: string } }[] = [];
    const paymentUrls: { kind: string; url: string }[] = [];
    
    for (const action of actions) {
      const order = this.d.store.getOrder(orderId);
      if (!order) {
        rejected.push({ action, reason: "order not found" });
        continue;
      }
      if (isTerminal(order.state)) {
        rejected.push({ action, reason: `order is terminal (${order.state})` });
        continue;
      }
      try {
        const reason = await this.applyOne(order, action);
        if (reason) {
          rejected.push({ action, reason });
        } else {
          applied.push(action);
          
          // After successful application, extract any generated mockups or payments from updated order state
          const updated = this.d.store.getOrder(orderId);
          if (updated && action.type === "request_mockup" && updated.job_spec) {
            const spec = JSON.parse(updated.job_spec);
            if (spec.mockup_urls) {
              console.log(`[applyAll] collected mockup presentation for order ${orderId}:`, spec.mockup_urls);
              presentations.push({ orderId, urls: spec.mockup_urls });
            } else {
              console.log(`[applyAll] request_mockup succeeded but no mockup_urls in spec`);
            }
          }
        }
      } catch (e) {
        // A handler threw (e.g. provider error). Reject this action, keep going;
        // money ops are individually idempotent so a later retry is safe.
        rejected.push({ action, reason: `handler error: ${(e as Error).message}` });
      }
    }
    return { applied, rejected, paymentUrls, presentations };
  }

  /** Returns a rejection reason string, or null if committed. */
  private async applyOne(order: Order, action: Action): Promise<string | null> {
    switch (action.type) {
      case "collect":
        return this.onCollect(order, action.fields);
      case "set_track":
        return this.onSetTrack(order, action.track);
      case "request_mockup":
        return this.onRequestMockup(order, action.variant, action.brief ?? this.lastBrief(order));
      case "select_mockup":
        return this.onSelectMockup(order, action.which);
      case "mockup_rejected":
        return this.onMockupRejected(order, action.notes);
      case "request_payment":
        return this.onRequestPayment(order, action.kind);
      case "revision_note":
        return this.onRevisionNote(order, action.note);
      case "approve_for_print":
        return this.onApproveForPrint(order);
      case "digital_complete":
        return this.onDigitalComplete(order);
      case "confirm_asset":
        return this.onConfirmAsset(order, action.asset_type);
      case "escalate":
        return this.onEscalate(order, action.reason, action.summary);
      case "cancel":
        return this.onCancel(order, action.reason);
    }
  }

  private lastBrief(order: Order): string {
    const spec = readSpec(order);
    return typeof spec.last_brief === "string" ? spec.last_brief : "";
  }

  // ── handlers ───────────────────────────────────────────────────────────

  private onCollect(order: Order, fields: Record<string, unknown>): string | null {
    const patch: Partial<Order> = {};
    const spec = readSpec(order);
    if (typeof spec.specs === 'string') {
      spec.specs = { description: spec.specs };
    } else if (typeof spec.specs !== 'object' || spec.specs === null) {
      spec.specs = {};
    }
    for (const [k, v] of Object.entries(fields)) {
      if (k === "client_name" && typeof v === "string") patch.client_name = v;
      else if (k === "business_name" && typeof v === "string") patch.business_name = v;
      else if (k === "project_type" && typeof v === "string") patch.project_type = v;
      else if (k === "ip_attestation" && typeof v === "object" && v !== null)
        spec.ip_attestation = v as JobSpec["ip_attestation"];
      else (spec.specs as Record<string, unknown>)[k] = v;
    }

    // Attempt to compute price_cents from accumulated specs.
    // Only set once — don't overwrite a price already locked in.
    // Dan-approval products: set escalation overlay so Penn can quote manually.
    if (!spec.price_cents) {
      const pricing = computePrice(spec.specs as PricingInputs);
      if (pricing.ok) {
        spec.price_cents = pricing.priceCents;
        // Observer-only: notify owner of high-value quotes. Non-blocking; does not gate the order.
        if (pricing.priceCents >= 100000) {
          this.d.notifier
            .postToPenn(
              `[high-value-quote] order ${order.order_id}: computed $${(pricing.priceCents / 100).toFixed(2)} — FYI only, no action required.`,
            )
            .catch(() => {/* tolerate; non-blocking */});
        }
      } else if (!pricing.ok && pricing.requiresDanApproval && !order.escalation) {
        patch.escalation = "manual";
        // Notify Penn async — fire and forget; non-blocking for the turn.
        const productName = pricing.productName;
        this.d.notifier
          .postToPenn(
            `[quote-needed] order ${order.order_id}: "${productName}" requires manual quoting before deposit can be charged.`,
          )
          .catch(() => {/* tolerate; heartbeat surfaces persistent issues */});
      }
      // If !pricing.ok && !requiresDanApproval: inputs incomplete; price deferred to next collect.
    }

    patch.job_spec = JSON.stringify(spec);
    this.d.store.patchOrder(order.order_id, patch);
    return null;
  }

  private onSetTrack(order: Order, track: "physical" | "digital"): string | null {
    if (order.track !== "undecided") return `track already set to ${order.track}`;
    this.d.store.patchOrder(order.order_id, { track });
    return null;
  }

  private async onConfirmAsset(
    order: Order,
    assetType: "logo" | "product" | "reference",
  ): Promise<string | null> {
    const pending = this.d.assetStore.pendingAssets(order.whatsapp_jid);
    if (pending.length === 0) return "no pending asset to confirm";
    const focus = pending[0]!;

    // Moderation gate: scan bytes for policy violations before confirming.
    const resolved = this.d.assetStore.resolveAssetById(focus.asset_id);
    if (resolved) {
      const modResult = await moderateAsset({ bytes: resolved.content, mimeType: "image/jpeg" });
      // Record the scan result in job_spec regardless of outcome.
      const spec = readSpec(order);
      spec.moderation_flag = {
        flagged: !modResult.ok,
        reason: modResult.reason,
        checked_at: new Date().toISOString(),
      };
      this.d.store.patchOrder(order.order_id, { job_spec: JSON.stringify(spec) });

      if (!modResult.ok) {
        const specFresh = readSpec(this.d.store.getOrder(order.order_id) ?? order);
        const att = specFresh.ip_attestation;
        if (att?.client_confirms_rights === true) {
          // Attested: proceed but send calibration alert so Dan can review.
          const productHint = (specFresh.specs as Record<string, unknown> | undefined)?.product_type
            ?? order.project_type
            ?? "unknown";
          void this.d.notifier
            .postToPenn(
              `[flagged-and-attested] ${order.order_id} ${productHint}: ${modResult.reason}`,
            )
            .catch(() => {/* non-blocking */});
        } else {
          // Not attested: reject so the brain can surface the issue to the client.
          return `content moderation flag: ${modResult.reason}`;
        }
      }
    }

    const role = assetType === "reference" ? "reference" : "fidelity";
    const promote = role === "fidelity";
    this.d.assetStore.confirmAssetRole(focus.asset_id, assetType, role, promote);
    console.log(`[action-applier] confirm_asset: asset_id=${focus.asset_id}, type=${assetType}, promoted=${promote}`);
    return null;
  }

  private async onRequestMockup(
    order: Order,
    variant: "A" | "B" | "both",
    brief: string,
  ): Promise<string | null> {
    // Legal entry points: first generation (intake) or regen (awaiting_decision / mockup).
    if (!["intake", "awaiting_decision", "mockup"].includes(order.state)) {
      return `cannot request mockup from state ${order.state}`;
    }
    // Asset gate: runs before state transition so order stays re-requestable on failure.
    const logo = this.d.assetStore.resolveLogo(order.whatsapp_jid, 'current');
    if (!logo) return "no logo on file — ask client to upload a logo image";
    if (!coarseUsable(logo)) return `logo below print floor (${logo.width_px}x${logo.height_px}px, vector=${logo.is_vector}) — ask client for higher resolution`;
    // Product images are not floor-gated: clients send phone photos and don't have
    // print-res versions. Compositor uses what's there; supplier flags quality at production.
    // Move to `mockup` (generating).
    let cur = order;
    if (cur.state === "intake") cur = this.d.store.transition(cur.order_id, "mockup");
    else if (cur.state === "awaiting_decision") cur = this.d.store.transition(cur.order_id, "mockup");
    // (already 'mockup' => stay)

    let urls;
    try {
      urls = await this.d.mockups.generate(cur, variant, brief);
    } catch (e) {
      void escalateForMockupFailure(
        this.d.store,
        this.d.notifier,
        cur.order_id,
        "generate_failed",
        `[escalation:mockup_gen] order ${cur.order_id}: generate threw: ${(e as Error).message}`
      );
      return `mockup generation failed: ${(e as Error).message}`;
    }

    const spec = readSpec(cur);
    spec.mockup_urls = { ...(spec.mockup_urls ?? {}), ...urls };
    spec.last_brief = brief;
    this.d.store.patchOrder(cur.order_id, { job_spec: JSON.stringify(spec) });

    // Do NOT transition here — host.ts loop owns the transition after media sends successfully
    return null;
  }

  private onSelectMockup(order: Order, which: "A" | "B"): string | null {
    if (order.state !== "awaiting_decision") {
      return `cannot select mockup from state ${order.state}`;
    }
    this.d.store.patchOrder(order.order_id, { selected_mockup: which });
    return null;
  }

  private async onMockupRejected(order: Order, notes?: string): Promise<string | null> {
    if (order.state !== "awaiting_decision") {
      return `mockup_rejected only valid at awaiting_decision (was ${order.state})`;
    }
    const failed = order.failed_mockup_pairs + 1;
    this.d.store.patchOrder(order.order_id, { failed_mockup_pairs: failed });

    if (failed >= MOCKUP_PAIR_LIMIT) {
      // Host-derived escalation (the brain never emits this).
      this.d.store.patchOrder(order.order_id, { escalation: "mockup_pairs" });
      this.d.store.appendEvent({
        order_id: order.order_id,
        actor: "flock",
        type: "escalation",
        payload: { reason: "mockup_pairs", failed_pairs: failed, notes: notes ?? null },
      });
      await this.d.notifier.postToPenn(
        `[escalation] order ${order.order_id}: ${failed} rejected mockup pairs — needs a human designer. Notes: ${notes || "(none)"}`,
      );
      return null;
    }

    // Regenerate a fresh pair from the provided notes or the last brief.
    // Notes (client feedback) take priority; fall back to last brief if no notes provided.
    const brief = (notes ?? "").trim() || this.lastBrief(order);
    this.d.store.transition(order.order_id, "mockup");
    const fresh = this.d.store.getOrder(order.order_id)!;
    let urls;
    try {
      urls = await this.d.mockups.generate(fresh, "both", brief);
    } catch (e) {
      void escalateForMockupFailure(
        this.d.store,
        this.d.notifier,
        fresh.order_id,
        "generate_failed",
        `[escalation:mockup_gen] order ${fresh.order_id}: generate threw: ${(e as Error).message}`
      );
      return `mockup generation failed: ${(e as Error).message}`;
    }
    const spec = readSpec(fresh);
    spec.mockup_urls = urls;
    spec.last_brief = brief; // Update brief if new notes provided
    this.d.store.patchOrder(fresh.order_id, { job_spec: JSON.stringify(spec) });
    this.d.store.transition(fresh.order_id, "awaiting_decision", { regen: true });
    return null;
  }

  private async onRequestPayment(
    order: Order,
    kind: "deposit" | "balance" | "digital",
  ): Promise<string | null> {
    // Only at a payment point AND no in-flight client payment.
    if (this.d.store.pendingClientPaymentKind(order.order_id) !== "none") {
      return "a client payment is already pending";
    }

    if (kind === "deposit") {
      if (order.track !== "physical") return "deposit requires physical track";
      if (order.state !== "awaiting_decision") return `deposit not valid from ${order.state}`;
      if (!canTransition(order.state, "deposit_pending")) return "illegal transition to deposit_pending";
      return this.charge(order, "deposit", () =>
        this.d.store.transition(order.order_id, "deposit_pending"),
      );
    }
    if (kind === "digital") {
      if (order.track !== "digital") return "digital payment requires digital track";
      
      // Digital auth: first block (initial awaiting_decision) vs re-block (revision)
      const isFirstBlock = order.state === "awaiting_decision";
      const isReBlock = order.state === "revision";
      
      if (!isFirstBlock && !isReBlock) {
        return `digital payment not valid from ${order.state}`;
      }
      
      const targetState = isFirstBlock ? "digital_pending" : "revision";
      if (!canTransition(order.state, targetState)) {
        return `illegal transition to ${targetState}`;
      }
      
      return this.charge(order, "digital", () =>
        isFirstBlock
          ? this.d.store.transition(order.order_id, "digital_pending")
          : null, // re-block stays in revision
      );
    }
    // balance: normally driven by approve_for_print; if emitted directly, require balance_pending.
    if (order.track !== "physical") return "balance requires physical track";
    if (order.state !== "balance_pending") return `balance not valid from ${order.state}`;
    return this.charge(order, "balance", () => {
      /* no state advance here; balance_pending->in_production is clearance+supplier gated */
    });
  }

  /** Shared charge path: PriceUnavailable becomes an escalation, not a guess. */
  private async charge(
    order: Order,
    kind: "deposit" | "balance" | "digital",
    onAccepted: (() => void) | null,
  ): Promise<string | null> {
    try {
      const result = await this.d.payments.requestClientPayment(order, kind, this.d.defaultMethod);
      if (result.payment.status === "failed") {
        // Charge failed — no money moved. Do NOT advance state (onAccepted not called)
        // and do NOT reject the action. The order stays at its payment gate, so the brain
        // can re-request on the next turn without hitting a state-machine rejection.
        // (Blocker 1 fix: "action processed" ≠ "state advanced".)
        this.d.store.appendEvent({
          order_id: order.order_id,
          actor: "flock",
          type: "payment",
          payload: { kind, status: "failed", retryable: true },
        });
        this.d.store.appendEvent({
          order_id: order.order_id,
          actor: "flock",
          type: "router",
          payload: { reason: "charge_failed", kind },
        });
        return null;
      }
      // succeeded or pending: intent exists, move the pipeline forward.
      if (onAccepted) onAccepted();
      return null;
    } catch (e) {
      if (e instanceof PriceUnavailable) {
        this.d.store.patchOrder(order.order_id, { escalation: "manual" });
        this.d.store.appendEvent({
          order_id: order.order_id,
          actor: "flock",
          type: "escalation",
          payload: { reason: "manual", detail: "price unavailable for charge", kind },
        });
        await this.d.notifier.postToPenn(
          `[escalation] order ${order.order_id}: needs a price before ${kind} can be charged.`,
        );
        return `price unavailable — escalated instead of charging ${kind}`;
      }
      throw e;
    }
  }

  private async onRevisionNote(order: Order, note: string): Promise<string | null> {
    const enterRevisionFrom = ["deposit_pending", "digital_pending", "revision"];
    if (!enterRevisionFrom.includes(order.state)) {
      return `revision_note not valid from ${order.state}`;
    }
    if (order.state !== "revision") {
      this.d.store.transition(order.order_id, "revision", { note });
    }
    const cur = this.d.store.getOrder(order.order_id)!;

    if (cur.track === "physical") {
      // Gated model: 3 free revisions, then signal for $5 block (brain emits request_payment)
      const entitlement = 3 + this.d.store.succeededRevisionBlocks(cur.order_id) * 3;
      if (this.d.store.appliedRevisions(cur.order_id) >= entitlement) {
        return "no revision rounds available — offer $5 block (3 revisions)";
      }
      this.d.store.recordRevisionEvent(cur.order_id, this.inboundEventId);
      await this.d.supplierQueue.queueRevision(cur, note);
      return null;
    }
    
    // Digital guard: check availableRounds before emitting revision_note
    const succeededBlocks = this.d.store.succeededDigitalBlocks(cur.order_id);
    const roundsUsed = cur.digital_rounds_used;
    const availableRounds = (succeededBlocks * 3) - roundsUsed;
    
    if (availableRounds < 1) {
      // No rounds left; escalate or offer $5 block (brain decides via context)
      return "no revision rounds available — escalate or offer $5 block";
    }
    
    // Consume a round and regen feeding the note.
    this.d.store.patchOrder(cur.order_id, { digital_rounds_used: roundsUsed + 1 });
    const spec = readSpec(cur);
    let urls;
    try {
      urls = await this.d.mockups.generate(cur, "both", note);
    } catch (e) {
      void escalateForMockupFailure(
        this.d.store,
        this.d.notifier,
        cur.order_id,
        "generate_failed",
        `[escalation:mockup_gen] order ${cur.order_id}: generate threw: ${(e as Error).message}`
      );
      return `mockup generation failed: ${(e as Error).message}`;
    }
    spec.mockup_urls = urls;
    spec.last_brief = note; // Update brief for context in next turn
    this.d.store.patchOrder(cur.order_id, { job_spec: JSON.stringify(spec) });
    return null;
  }

  private async onApproveForPrint(order: Order): Promise<string | null> {
    if (order.track !== "physical") return "approve_for_print requires physical track";
    // Deposit must have cleared before production is approved (should-fix 5).
    // A pending deposit (manual, not yet confirmed) does not gate production.
    const depositCleared = this.d.store
      .listPayments(order.order_id)
      .some((p) => p.kind === "deposit" && p.direction === "in" && p.status === "succeeded");
    if (!depositCleared) {
      return "deposit has not cleared — approve_for_print blocked until payment is confirmed";
    }
    // Reach balance_pending via revision (machine has no deposit_pending->balance_pending).
    let cur = order;
    if (cur.state === "deposit_pending") cur = this.d.store.transition(cur.order_id, "revision");
    if (cur.state !== "revision") return `approve_for_print not valid from ${cur.state}`;
    cur = this.d.store.transition(cur.order_id, "balance_pending", { approved_for_print: true });

    // Trigger the balance charge (50%). PriceUnavailable -> escalate.
    return this.charge(cur, "balance", () => {
      /* in_production fires on balance clearance + supplier selection (host) */
    });
  }

  private async onDigitalComplete(order: Order): Promise<string | null> {
    if (order.track !== "digital") return "digital_complete requires digital track";
    let cur = order;
    if (cur.state === "digital_pending") cur = this.d.store.transition(cur.order_id, "revision");
    if (cur.state !== "revision") return `digital_complete not valid from ${cur.state}`;

    const { url } = await this.d.delivery.deliverFinal(cur);
    const spec = readSpec(cur);
    spec.final_url = url;
    this.d.store.patchOrder(cur.order_id, { job_spec: JSON.stringify(spec) });
    this.d.store.transition(cur.order_id, "closed", { final_url: url });
    return null;
  }

  private async onEscalate(
    order: Order,
    reason: "friction" | "supplier" | "manual",
    summary?: string,
  ): Promise<string | null> {
    this.d.store.patchOrder(order.order_id, { escalation: reason });
    this.d.store.appendEvent({
      order_id: order.order_id,
      actor: "flock",
      type: "escalation",
      payload: { reason, summary: summary ?? null },
    });
    await this.d.notifier.postToPenn(
      `[escalation:${reason}] order ${order.order_id}${summary ? ` — ${summary}` : ""}`,
    );
    return null; // overlay; state unchanged
  }

  private onCancel(order: Order, reason: string): string | null {
    if (this.d.store.hasHeldMoney(order.order_id)) {
      return "money is held — cancel refused (refund/escalation required)";
    }
    if (!canTransition(order.state, "cancelled")) return `cannot cancel from ${order.state}`;
    this.d.store.transition(order.order_id, "cancelled", { reason });
    return null;
  }
}
