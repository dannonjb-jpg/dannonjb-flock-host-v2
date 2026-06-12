// host.ts
// The canonical inbound turn lifecycle (§4) wired from ports, so it is fully testable
// without the real socket/SDKs. The host disposes; the brain only proposes.

import { Store } from "./store/store.js";
import { Clock, IdGen } from "./domain/ports.js";
import { Order } from "./domain/types.js";
import { selectModel, RoutingDecision } from "./model-router.js";
import { derivePhase } from "./domain/phase.js";
import { Brain, buildContextHeader } from "./brain/hermes-client.js";
import { parseBrainOutput } from "./brain/actions.js";
import { ActionApplier } from "./brain/action-applier.js";
import { PaymentOps } from "./payments/payment-ops.js";
import { Notifier } from "./domain/integrations.js";
import { WhatsAppChannel, InboundMessage } from "./channel/channel.js";
import { Cadence } from "./channel/cadence.js";
import { Obs, type TurnCtx } from "./obs/obs.js";
import type { Logger } from "pino";
import pino from "pino";
import { postEscalation, escalateForMockupFailure } from "./ops/escalation.js";
import { AssetStore } from "./store/asset-store.js";

// Silent logger fallback for tests/construction without explicit logger.
const silentLogger = pino({ level: "silent" });

export interface HostDeps {
  store: Store;
  brain: Brain;
  applier: ActionApplier;
  payments: PaymentOps;
  channel: WhatsAppChannel;
  cadence: Cadence;
  notifier: Notifier;
  clock: Clock;
  idGen: IdGen;
  sleep: (ms: number) => Promise<void>;
  systemPrompt: string;         // SOUL contract text, loaded at boot
  assetStore: AssetStore;       // for media ingestion + quoting
  historyLimit?: number;        // conversation turns to include (default 10 exchanges)
  logger?: Logger;              // optional; if not provided, silent logger is used internally
}

export class Host {
  private obs: Obs;

  constructor(private d: HostDeps) {
    // Create the observability module with the provided logger (or silent default).
    // This way existing tests don't break — they don't pass a logger, and Obs still exists.
    this.obs = new Obs(d.logger ?? silentLogger);
  }

  attach(): void {
    this.d.channel.onInbound((msg) => this.handleInbound(msg));
  }

  /** §4 — the canonical path. Safe to re-run for an unanswered inbound (§9). */
  async handleInbound(
    msg: InboundMessage,
    opts?: { replayInboundEventId?: string },
  ): Promise<void> {
    const replay = !!opts?.replayInboundEventId;

    // Guard: skip non-client JIDs (status broadcasts, groups) for 1:1 flow.
    // Groups (@g.us) and status@broadcast have no corresponding client.
    if (msg.jid === 'status@broadcast' || msg.jid.endsWith('@g.us')) {
      console.log(`[host] Skipping non-client JID: ${msg.jid}`);
      return;
    }

    // 2. Resolve order (most recent non-terminal for the JID, else create intake).
    let order = this.d.store.findActiveOrderByJid(msg.jid) ?? this.d.store.createOrder(msg.jid);

    // 1. Append the inbound event; its id is the inbound_event_id used for linking.
    //    On replay we reuse the original inbound event rather than recording a new one.
    // 1. Determine the inbound_event_id (fresh append or replay reuse)
    const inboundEventId = replay
      ? opts!.replayInboundEventId!
      : this.d.store.appendEvent({
          order_id: order.order_id,
          actor: "client",
          type: "msg_recv",
          payload: {
            text: msg.text,
            wa_media_ref: msg.media?.ref, // opaque; undefined if no media
            media_mime: msg.media?.mime,
          },
        }).event_id;

    // 1c. If the inbound has media, download and ingest it as an asset.
    // NOTE: writeAsset is idempotent (content-addressed dedup), so re-ingest on replay
    // is safe. Removing the replay check prevents silent asset loss if the host crashes
    // between msg_recv append and asset ingest; reconciliation will replay and re-ingest.
    const ev = replay ? this.d.store.getEvent(inboundEventId) : undefined;
    const mediaRef = replay ? (ev?.payload as any)?.wa_media_ref : msg.media?.ref;
    const mediaMime = replay ? (ev?.payload as any)?.media_mime : msg.media?.mime;

    if (mediaRef !== undefined) {
      try {
        const bytes = await this.d.channel.downloadMedia(mediaRef); // retry is inside
        await this.d.assetStore.writeAsset({
          jid: msg.jid,
          content: bytes,
          source_message: inboundEventId,
          mime: mediaMime,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.d.logger?.error({ err, inboundEventId }, "media ingest failed");
        // If re-download hard-fails (e.g., media expired), escalate to Penn
        if (replay && detail.includes("download")) {
          void postEscalation(
            this.d.store,
            this.d.notifier,
            order.order_id,
            "media_recovery_failed",
            `Order ${order.order_id} (${msg.jid}): Logo received but media server hard-failed on recovery. Asset lost.`,
          );
        }
        // Continue turn; don't crash on media ingest failure
      }
    }

    // 3. turn_count += 1 (skipped on replay to avoid double-counting); clear dormancy.
    order = this.d.store.patchOrder(order.order_id, {
      turn_count: replay ? order.turn_count : order.turn_count + 1,
      dormant_since: null,
      follow_up_stage: 0,
      hermes_session_id: order.hermes_session_id ?? order.order_id,
    });

    // Build turn context for observability (passed through §4).
    const ctx: TurnCtx = {
      order_id: order.order_id,
      inbound_event_id: inboundEventId,
      jid: msg.jid,
      turn: order.turn_count,
    };

    // Log inbound.
    this.obs.inbound(ctx, msg.text);

    // 4. Derive phase -> route -> persist tier -> log reason.
    const decision = this.route(order, msg.text);
    this.d.store.patchOrder(order.order_id, { last_tier: decision.tier });
    this.d.store.appendEvent({
      order_id: order.order_id,
      actor: "system",
      type: "router",
      payload: { tier: decision.tier, model: decision.model, reason: decision.reason },
    });
    this.obs.router(ctx, decision.tier, decision.reason);

    // 5. Read-receipt cadence.
    await this.d.sleep(this.d.cadence.readDelayMs(msg.text));
    await this.d.channel.readMessages(msg.jid);

    // 5a. Image-input stopgap: if text is empty (media-only message), forward to brain with synthetic text.
    // Prevents 400 errors on media-only inputs while letting the brain handle naturally.
    if (!msg.text || msg.text.trim() === "") {
      console.log(`[host:stopgap] order ${order.order_id}: empty-text message (media-only), forwarding to brain with synthetic text`);
      // Generic placeholder for media-only messages
      // Brain will interpret based on context (intake = likely logo, awaiting_decision = likely reference or feedback)
      msg.text = order.state === "intake" 
        ? "[client sent an image — likely a logo or reference image]"
        : "[client sent an image as feedback or reference]";
      // Continue to brain call below (no early return)
    }

    // 6. Brain-attempt marker: log entry before calling brain (durable record)
    this.d.store.appendEvent({
      order_id: order.order_id,
      actor: "system",
      type: "brain_attempt",
      payload: { message: msg.text, timestamp: new Date().toISOString() },
      inbound_event_id: inboundEventId,
    });

    // 6b. Call the brain with the context header + model override + conversation history.
    const header = buildContextHeader(order, this.d.store, this.d.assetStore);
    const history = this.d.store.getConversationHistory(
      order.order_id,
      this.d.historyLimit ?? 10,
    );
    let raw: string;
    const brainStart = Date.now();
    try {
      raw = await this.d.brain.ask({
        sessionId: order.hermes_session_id ?? order.order_id,
        message: msg.text,
        model: decision.model,
        contextHeader: header,
        history,
        systemPrompt: this.d.systemPrompt,
      });
      const brainMs = Date.now() - brainStart;
      const isSilent = raw.toLowerCase().includes("[silent]");
      this.obs.brain(ctx, decision.model, brainMs, raw.length, isSilent);
      
      // Brain-outcome marker: log success
      this.d.store.appendEvent({
        order_id: order.order_id,
        actor: "system",
        type: "brain_outcome",
        payload: { status: "ok", latencyMs: brainMs },
        inbound_event_id: inboundEventId,
      });
    } catch (err) {
      // Brain-outcome marker: log failure
      const detail = err instanceof Error ? err.message : String(err);
      this.d.store.appendEvent({
        order_id: order.order_id,
        actor: "system",
        type: "brain_outcome",
        payload: { status: "error", error: detail },
        inbound_event_id: inboundEventId,
      });
      
      // The brain failed (auth, rate limit, transient API/network error). This MUST NOT
      // crash the process that owns the WhatsApp socket. Log it, escalate to Penn, send
      // the client a brief holding line, mark the inbound answered (so reconcile does not
      // replay-loop it), and end the turn cleanly.
      console.error(`[host] brain error on order ${order.order_id}: ${detail}`);
      // Post escalation with delivery tracking.
      void postEscalation(
        this.d.store,
        this.d.notifier,
        order.order_id,
        "brain_error",
        `Flock brain error on order ${order.order_id} (${msg.jid}): ${detail} | client said: ${msg.text}`,
      );
      const holding = "Thanks! Give me just a moment and I'll be right with you.";
      this.d.store.appendEvent({
        order_id: order.order_id,
        actor: "flock",
        type: "msg_sent",
        payload: { text: holding, brain_error: true },
        inbound_event_id: inboundEventId,
      });
      try {
        await this.d.channel.setPresence(msg.jid, "composing");
        await this.d.sleep(this.d.cadence.typingMs(holding));
        await this.d.channel.sendMessage(msg.jid, holding);
        await this.d.channel.setPresence(msg.jid, "paused");
      } catch (sendErr) {
        const s = sendErr instanceof Error ? sendErr.message : String(sendErr);
        console.error(`[host] failed to send holding message: ${s}`);
      }
      this.d.store.patchOrder(order.order_id, {});
      return;
    }

    // 7. Parse + apply actions (validated against the state machine).
    const parsed = parseBrainOutput(raw);
    if (parsed.parseError) {
      this.d.store.appendEvent({
        order_id: order.order_id,
        actor: "system",
        type: "state_change",
        payload: { actions_parse_error: parsed.parseError },
      });
    }
    let paymentUrls: { kind: string; url: string }[] = [];
    let presentations: { orderId: string; urls: import("./domain/integrations.js").MockupUrls }[] = [];
    let effectiveReply = parsed.reply;
    if (parsed.actions.length > 0) {
      const outcome = await this.d.applier.applyAll(order.order_id, parsed.actions, inboundEventId);
      paymentUrls = outcome.paymentUrls ?? [];
      presentations = outcome.presentations ?? [];
      // Log which actions were applied vs rejected (for Phase 2a failure injection validation).
      const appliedNames = outcome.applied.map((a) => a.type);
      const rejectedWithReasons = outcome.rejected.map((r) => ({ type: r.action.type, reason: r.reason }));
      this.obs.actions(ctx, appliedNames, rejectedWithReasons);
      for (const r of outcome.rejected) {
        this.d.store.appendEvent({
          order_id: order.order_id,
          actor: "system",
          type: "state_change",
          payload: { rejected_action: r.action, reason: r.reason },
        });
      }
      // If request_mockup was rejected, the brain wrote an optimistic reply it must not send.
      // Substitute the gate's reason so the client gets accurate information instead of a
      // false promise ("mockups are coming") when the gate blocked the action.
      const mockupRej = outcome.rejected.find(r => r.action.type === "request_mockup");
      if (mockupRej) effectiveReply = mockupRej.reason;
    }
    if (parsed.rejected.length > 0) {
      this.d.store.appendEvent({
        order_id: order.order_id,
        actor: "system",
        type: "state_change",
        payload: { malformed_actions: parsed.rejected },
      });
    }

    // 8. & 9. Record the outbox intent BEFORE the socket call (should-fix 4).
    //    A crash between appendEvent and sendMessage leaves the message as "answered" —
    //    at-most-once (rare lost reply) beats at-least-once (guaranteed duplicate). The
    //    client receives a duplicate on the next turn otherwise; reconcile would replay.
    const willSend = !parsed.silent && effectiveReply.length > 0;
    this.d.store.appendEvent({
      order_id: order.order_id,
      actor: "flock",
      type: "msg_sent",
      payload: willSend ? { text: effectiveReply } : { silent: true },
      inbound_event_id: inboundEventId,
    });

    if (willSend) {
      this.obs.outbound(ctx, effectiveReply.length);
      await this.d.channel.setPresence(msg.jid, "composing");
      await this.d.sleep(this.d.cadence.typingMs(effectiveReply));
      // In intake phase, quote the focus image so the client knows which asset is being asked about.
      const pending = this.d.assetStore.pendingAssets(msg.jid);
      let quoted: unknown;
      if (pending.length > 0) {
        const ev = this.d.store.getEvent(pending[0]!.source_message ?? "");
        quoted = (ev?.payload as any)?.wa_media_ref;
      }
      await this.d.channel.sendMessage(msg.jid, effectiveReply, { quoted });
      await this.d.channel.setPresence(msg.jid, "paused");
    }

    // Send any payment URLs as follow-up messages so the client has a tappable link.
    for (const { url } of paymentUrls) {
      await this.d.sleep(600);
      await this.d.channel.sendMessage(msg.jid, url);
    }

    // Send mockup images then advance to awaiting_decision (present-before-advance).
    for (const p of presentations) {
      const pOrder = this.d.store.getOrder(p.orderId);
      if (!pOrder) continue;
      try {
        let sent = 0;
        for (const [variant, url] of Object.entries(p.urls)) {
          if (url) {
            await this.d.channel.sendMedia(pOrder.whatsapp_jid, url as string, `Option ${variant}`);
            sent++;
          }
        }
        
        if (sent > 0) {
          // Only transition after confirmed send
          this.d.store.transition(p.orderId, "awaiting_decision", { presented: true });
        } else {
          // No URLs were sent — escalate generate failure
          void escalateForMockupFailure(
            this.d.store,
            this.d.notifier,
            p.orderId,
            "generate_failed",
            `[escalation:mockup_gen] order ${p.orderId}: pipeline returned no URLs`
          );
        }
      } catch (e) {
        // Send failed — leave order at `mockup`; escalate to Penn (shared path with generate-fail).
        const msg = (e as Error).message;
        void escalateForMockupFailure(
          this.d.store,
          this.d.notifier,
          p.orderId,
          "send_failed",
          `[escalation:mockup_send] order ${p.orderId}: media send failed: ${msg}`,
        );
      }
    }

    // Bump updated_at to close the turn.
    this.d.store.patchOrder(order.order_id, {});
  }

  private route(order: Order, message: string): RoutingDecision {
    return selectModel({
      message,
      phase: derivePhase(order),
      currentTier: order.last_tier,
      forceTier: order.force_tier,
    });
  }

  // ── clearance / supplier-driven advancement (off the brain path) ────────────

  /**
   * Called when a payment clears (Stripe webhook, reconciliation, or Dan-via-Penn
   * manual confirm). The brain is told a payment cleared ONLY after this commits (§7).
   */
  async onPaymentConfirmed(paymentId: string, externalRef?: string): Promise<void> {
    // One atomic transaction: mark payment + append event + transition state.
    // Crash anywhere inside → entire transaction rewinds, next retry sees pending payment (retries).
    // Crash after commit → next delivery sees succeeded payment (fast-path no-op).
    const tx = (this.d.store as any).db.transaction(() => {
      const { won, payment } = this.d.payments.confirmInTransaction(paymentId, externalRef);
      if (!won) return; // Lost the race, no-op.
      
      const order = this.d.store.getOrder(payment.order_id);
      if (!order) return;
      
      // Only the winner advances state (in the same transaction).
      if (payment.kind === "deposit" && payment.direction === "in") {
        if (order.state === "deposit_pending") {
          this.d.store.transition(order.order_id, "revision");
        }
      } else if (payment.kind === "digital" && payment.direction === "in") {
        if (order.state === "digital_pending") {
          this.d.store.transition(order.order_id, "revision");
        }
      }
    });
    tx();
    
    // Balance payment — advance is external (maybeEnterProduction), separate from atomic unit.
    const payment = this.d.store.getPayment(paymentId);
    if (payment && payment.kind === "balance" && payment.status === "succeeded") {
      const order = this.d.store.getOrder(payment.order_id);
      if (order) {
        await this.maybeEnterProduction(order);
      }
    }
  }

  /** Penn set quotes.status='selected'; promote it onto the order (§11). */
  async onSupplierSelected(orderId: string): Promise<void> {
    const quote = this.d.store.getSelectedQuote(orderId);
    if (!quote) return;
    const order = this.d.store.patchOrder(orderId, { assigned_supplier_id: quote.supplier_id });
    this.d.store.appendEvent({
      order_id: orderId,
      actor: "penn",
      type: "state_change",
      payload: { supplier_selected: quote.supplier_id, quote_id: quote.quote_id },
    });
    await this.maybeEnterProduction(order);
  }

  /** in_production requires: at balance_pending, balance cleared, AND a supplier chosen. */
  private async maybeEnterProduction(order: Order): Promise<void> {
    if (order.state !== "balance_pending") return;
    if (!order.assigned_supplier_id) return;
    const balanceCleared = this.d.store
      .listPayments(order.order_id)
      .some((p) => p.kind === "balance" && p.direction === "in" && p.status === "succeeded");
    if (!balanceCleared) return;

    this.d.store.transition(order.order_id, "in_production", { supplier: order.assigned_supplier_id });

    // Pay the supplier deposit (direction out). Amount from the selected quote.
    const quote = this.d.store.getSelectedQuote(order.order_id);
    if (quote?.amount_cents && quote.currency) {
      await this.d.payments.requestSupplierDeposit(
        this.d.store.getOrder(order.order_id)!,
        quote.supplier_id,
        Math.round(quote.amount_cents * 0.5), // 50% supplier deposit (see README D-6)
        quote.currency,
        "stripe",
      );
    }
  }
}
