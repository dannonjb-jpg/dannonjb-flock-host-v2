// ops/escalation.ts
// Posts to Penn's Telegram channel (§11). Uses the Bot API over HTTPS via global
// fetch — no SDK dependency. The host holds the bot token + chat id.

import { Notifier } from "../domain/integrations.js";
import type { Store } from "../store/store.js";

export class TelegramNotifier implements Notifier {
  constructor(
    private botToken: string,
    private chatId: string,
  ) {}

  async postToPenn(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      // Never throw into the turn path over a notify failure; log and move on.
      console.error(`[escalation] telegram post failed: ${res.status} ${await res.text()}`);
    }
  }
}

/** No-op notifier for tests / local runs without a token. */
export class ConsoleNotifier implements Notifier {
  async postToPenn(text: string): Promise<void> {
    console.log(`[penn] ${text}`);
  }
}

// ── Escalation-specific wrappers ──────────────────────────────────────────────────
// These wrap postToPenn with delivery tracking and event logging.

/**
 * Post an escalation to Penn, logging delivery success/failure as an event.
 * Used only for genuine escalations (mockup bridge failures, brain errors, manual quotes).
 * Appends an event with {reason, delivered: boolean}.
 */
export async function postEscalation(
  store: Store,
  notifier: Notifier,
  orderId: string,
  reason: string,
  text: string,
): Promise<void> {
  let delivered = false;
  try {
    await notifier.postToPenn(text);
    delivered = true;
    console.log(`[escalation] delivered to penn: ${reason} on order ${orderId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[escalation] FAILED to post to penn: ${reason} on order ${orderId}: ${msg}`);
  }
  // Record delivery status regardless of success/fail.
  store.appendEvent({
    order_id: orderId,
    actor: "system",
    type: "escalation",
    payload: { reason, delivered },
  });
}

/**
 * Post a non-escalation message to Penn (follow-ups, heartbeats, status checks).
 * No event is logged. Failure is caught and logged but never thrown.
 */
export async function postToPennSafe(
  notifier: Notifier,
  text: string,
  where: string,
): Promise<void> {
  try {
    await notifier.postToPenn(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${where}] postToPenn failed: ${msg}`);
    // Swallow — heartbeat or follow-up failure is not critical to order state.
  }
}

/**
 * Shared escalation helper for mockup failures (generate-fail or send-fail).
 * Sets escalation + marker atomically, guards re-escalation, posts to Penn.
 * Both paths (generate exception + send failure) call this to stay in sync.
 */
export async function escalateForMockupFailure(
  store: Store,
  notifier: Notifier,
  orderId: string,
  failureType: "bridge_failed" | "send_failed" | "generate_failed",
  message: string,
): Promise<void> {
  const order = store.getOrder(orderId);
  if (!order) return; // Order vanished; nothing to do.

  // Guard re-escalation: if already escalated for a mockup reason, log but don't re-ping.
  if (order.escalation === "manual") {
    const spec = order.job_spec ? (JSON.parse(order.job_spec) as Record<string, unknown>) : {};
    if (spec.mockup_failed_escalation === true) {
      console.log(`[escalation] order ${orderId}: mockup already escalated, skipping re-ping`);
      return;
    }
  }

  // Set marker + escalation atomically; no crash window.
  const spec = order.job_spec ? (JSON.parse(order.job_spec) as Record<string, unknown>) : {};
  spec.mockup_failed_escalation = true;
  spec.mockup_failure_type = failureType;

  store.patchOrder(orderId, {
    escalation: "manual",
    job_spec: JSON.stringify(spec),
  });

  // Post to Penn with delivery tracking.
  await postEscalation(
    store,
    notifier,
    orderId,
    `mockup_${failureType}`,
    message,
  );
}
