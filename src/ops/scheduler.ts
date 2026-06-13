// ops/scheduler.ts
// §8 going-dark cadence. Runs on a timer, off the inbound path. The dormancy clock is
// measured from the client's last activity (orders.updated_at), which the host's own
// follow-ups must NOT reset — so we use store.setDormancy (no updated_at bump) and
// append-only events for the follow-up messages.
//
// Cadence stages: 1 (~36-48h), 2 (7-day), 3 (monthly). For orders that are post-deposit
// and forfeitable, the stage-1 message states the forfeit terms, and at 30 days the
// deposit is 100% forfeit -> the order transitions to `forfeited` (see README D-7).

import { Store } from "../store/store.js";
import { Clock } from "../domain/ports.js";
import { Order } from "../domain/types.js";
import { Brain, buildContextHeader } from "../brain/hermes-client.js";
import { parseBrainOutput } from "../brain/actions.js";
import { ActionApplier } from "../brain/action-applier.js";
import { WhatsAppChannel } from "../channel/channel.js";
import { Cadence } from "../channel/cadence.js";
import { Notifier } from "../domain/integrations.js";
import { selectModel } from "../model-router.js";
import { postToPennSafe, escalateForMockupFailure } from "./escalation.js";

const H = 3600_000;
export interface ScheduleConfig {
  stage1Ms: number; // first nudge
  stage2Ms: number; // 7-day
  stage3Ms: number; // monthly
  forfeitMs: number; // 100% deposit forfeit -> forfeited
}
export const DEFAULT_SCHEDULE: ScheduleConfig = {
  stage1Ms: 36 * H,
  stage2Ms: 7 * 24 * H,
  stage3Ms: 30 * 24 * H,
  forfeitMs: 30 * 24 * H,
};

const FORFEITABLE = new Set(["deposit_pending", "revision", "balance_pending"]);

export class Scheduler {
  private followUpModel = selectModel({ message: "", forceTier: "smart" }).model;
  private static readonly MOCKUP_TIMEOUT_MS = 90_000; // 90 seconds (p99 real DALLE ~60s + 30s buffer)

  constructor(
    private d: {
      store: Store;
      brain: Brain;
      applier: ActionApplier;
      channel: WhatsAppChannel;
      cadence: Cadence;
      notifier: Notifier;
      clock: Clock;
      sleep: (ms: number) => Promise<void>;
      systemPrompt: string;
      cfg?: ScheduleConfig;
    },
  ) {}

  private cfg(): ScheduleConfig {
    return this.d.cfg ?? DEFAULT_SCHEDULE;
  }

  /** One sweep. Call on an interval (e.g. hourly). Staggers sends to look human. */
  async sweep(): Promise<void> {
    // Standard dormancy-based follow-up sweep (decoupled from fast watchdog).
    const cfg = this.cfg();
    const quietSince = new Date(this.d.clock.nowMs() - cfg.stage1Ms).toISOString();
    const orders = this.d.store.findQuietOrders(quietSince);
    for (const order of orders) {
      try {
        await this.handle(order);
      } catch (e) {
        console.error(`[scheduler] order ${order.order_id}: ${(e as Error).message}`);
      }
      await this.d.sleep(1500 + Math.floor(Math.random() * 2500)); // jittered stagger
    }
  }

  /**
   * Watchdog for orders stuck at mockup. Runs on a fast ~30s interval (decoupled from dormancy sweep).
   * Anchors to state-entry time (→mockup transition), NOT updated_at.
   * This is invariant to customer pings and reassurance churn; catches both
   * hung-generate and brain-never-emitted cases. Precise fix for should-fix #3.
   *
   * Note: scans ALL non-terminal orders (not just quiet ones), since a pinging customer
   * keeps updated_at fresh and would bypass a findQuietOrders-based watchdog.
   * Re-checks state at escalation time to prevent false-positive stalling of fast generations.
   */
  async watchMockupState(): Promise<void> {
    console.log(`[scheduler:mockup-watch] tick (checking ${new Date().toISOString()})`);
    try {
      const candidates = this.d.store.getAllNonTerminalOrders();
      const now = this.d.clock.nowMs();

      for (const order of candidates) {
        if (order.state !== "mockup") continue;
        if (order.escalation === "manual") continue; // already escalated

        // Anchor to state-entry time: when the order transitioned TO mockup.
        // This timestamp is invariant to every subsequent ping, reassurance reply, or patch.
        let enteredAt = this.d.store.getStateEntryTime(order.order_id, "mockup");
        if (!enteredAt) {
          // Fallback for malformed/missing state_change event (safety, not expected).
          // Use updated_at instead of skipping — ensures no mockup order becomes un-watchable.
          console.warn(`[scheduler:mockup-watch] order ${order.order_id}: no state_change event; falling back to updated_at`);
          enteredAt = order.updated_at;
          if (!enteredAt) continue; // only skip if both are missing
        }

        const enteredMs = Date.parse(enteredAt);
        if (isNaN(enteredMs)) continue;

        const elapsed = now - enteredMs;
        if (elapsed > Scheduler.MOCKUP_TIMEOUT_MS) {
          // Re-read state before escalating (order may have advanced while we were checking).
          // This prevents false-positive stalling: a slow-but-successful generation that
          // moves to awaiting_decision between our elapsed-time check and escalation should NOT
          // get escalated retroactively (conditional-clear already ran, won't re-clear).
          const fresh = this.d.store.getOrder(order.order_id);
          if (fresh?.state !== "mockup") {
            console.log(`[scheduler:mockup-watch] order ${order.order_id}: already at ${fresh?.state}, skipping stale escalation`);
            continue; // Order succeeded, don't escalate
          }

          void escalateForMockupFailure(
            this.d.store,
            this.d.notifier,
            order.order_id,
            "send_failed",
            `[escalation:mockup_timeout] order ${order.order_id}: stuck in mockup state for ${Math.round(elapsed / 1000)}s (since entry) — may need manual intervention.`,
          );
        }
      }
    } catch (e) {
      console.error(`[scheduler:mockup-watch] error: ${(e as Error).message}`);
    }
  }

  private depositPaid(order: Order): boolean {
    // Digital orders have no deposit — only physical orders with a cleared deposit row
    // are subject to the deposit-forfeit rules (§8). "Any inbound payment" is wrong;
    // a $5 digital payment would otherwise trigger the forfeit path on digital orders.
    if (order.track !== "physical") return false;
    return this.d.store
      .listPayments(order.order_id)
      .some((p) => p.kind === "deposit" && p.direction === "in" && p.status === "succeeded");
  }

  private async handle(order: Order): Promise<void> {
    const cfg = this.cfg();
    // Anchor to dormant_since once set; updated_at is bumped by Penn actions (supplier
    // selection, payment confirmation) even when the client is still silent. Using
    // dormant_since means the forfeit clock is immune to host writes. (should-fix 3)
    const anchor = order.dormant_since ?? order.updated_at;
    const elapsed = this.d.clock.nowMs() - Date.parse(anchor);
    const forfeitable = FORFEITABLE.has(order.state) && this.depositPaid(order);

    // 100% forfeit at 30 days for a paid, forfeitable order.
    if (forfeitable && elapsed >= cfg.forfeitMs) {
      this.d.store.transition(order.order_id, "forfeited", {
        reason: "dormant_30d",
        retained: "100%",
      });
      void postToPennSafe(
        this.d.notifier,
        `[forfeit] order ${order.order_id}: 30 days dark with deposit held — marked forfeited (100%).`,
        "scheduler:forfeit",
      );
      return;
    }

    const targetStage = elapsed >= cfg.stage3Ms ? 3 : elapsed >= cfg.stage2Ms ? 2 : 1;
    if (targetStage <= order.follow_up_stage) return; // already nudged at this stage

    // Anchor dormancy on first detection; advance the stage. No updated_at bump.
    const dormantSince = order.dormant_since ?? order.updated_at;
    this.d.store.setDormancy(order.order_id, dormantSince, targetStage);

    await this.composeAndSend(order, targetStage, forfeitable);
  }

  private async composeAndSend(order: Order, stage: number, forfeitable: boolean): Promise<void> {
    const fresh = this.d.store.getOrder(order.order_id);
    if (!fresh) return;

    const termsLine =
      forfeitable && stage === 1
        ? " Mention gently that, per our terms, the deposit holds the slot for 7 days and is fully forfeit if we don't hear back within 30."
        : "";
    const instruction =
      `[compose follow-up] The client has gone quiet (stage ${stage}). Write a brief, warm, ` +
      `non-pushy check-in that moves the order forward from where it stands.${termsLine} ` +
      `One short message. Do not claim anything happened that hasn't.`;

    const raw = await this.d.brain.ask({
      sessionId: fresh.hermes_session_id ?? fresh.order_id,
      message: instruction,
      model: this.followUpModel,
      contextHeader: buildContextHeader(fresh, this.d.store),
      history: this.d.store.getConversationHistory(fresh.order_id, 6),
      systemPrompt: this.d.systemPrompt,
    });

    const parsed = parseBrainOutput(raw);
    if (parsed.actions.length > 0) await this.d.applier.applyAll(fresh.order_id, parsed.actions);

    if (parsed.silent || parsed.reply.length === 0) return;

    await this.d.channel.setPresence(fresh.whatsapp_jid, "composing");
    await this.d.sleep(this.d.cadence.typingMs(parsed.reply));
    await this.d.channel.sendMessage(fresh.whatsapp_jid, parsed.reply);
    await this.d.channel.setPresence(fresh.whatsapp_jid, "paused");

    // Follow-up has no inbound to link; record it append-only WITHOUT bumping updated_at.
    this.d.store.appendEvent({
      order_id: fresh.order_id,
      actor: "flock",
      type: "msg_sent",
      payload: { text: parsed.reply, follow_up_stage: stage },
      inbound_event_id: null,
    });
  }
}
