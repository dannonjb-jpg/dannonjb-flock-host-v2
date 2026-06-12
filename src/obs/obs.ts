// src/obs/obs.ts
// Structured turn observability — every turn carries order_id + inbound_event_id for reconstruction.
// All logs are pino children of the boot logger, so they integrate with systemd/journalctl natively.

import type { Logger } from "pino";

export function maskJid(jid?: string): string {
  if (!jid) return "?";
  const num = jid.split("@")[0] ?? jid;
  return num.length <= 4 ? "****" : `…${num.slice(-4)}`;
}

export interface TurnCtx {
  order_id: string;
  inbound_event_id: string;
  jid: string;
  turn: number;
}

export class Obs {
  private log: Logger;
  constructor(parent: Logger) {
    this.log = parent.child({ class: "flock-turn" });
  }

  private base(c: TurnCtx) {
    return { order_id: c.order_id, ieid: c.inbound_event_id, jid: maskJid(c.jid), turn: c.turn };
  }

  inbound(c: TurnCtx, text: string) {
    this.log.info(
      { ...this.base(c), step: "msg_recv", len: text.length, head: text.slice(0, 24) },
      "inbound"
    );
  }

  router(c: TurnCtx, tier: string, reason: string) {
    this.log.info({ ...this.base(c), step: "router", tier, reason }, "router");
  }

  brain(c: TurnCtx, model: string, ms: number, replyLen: number, silent: boolean) {
    this.log.info(
      { ...this.base(c), step: "brain", model, ms, replyLen, silent },
      "brain"
    );
  }

  // Critical for failure validation: which intents were applied vs rejected and WHY.
  actions(c: TurnCtx, applied: string[], rejected: { type: string; reason: string }[]) {
    this.log.info({ ...this.base(c), step: "apply", applied, rejected }, "actions");
  }

  state(c: TurnCtx, from: string, to: string) {
    this.log.info({ ...this.base(c), step: "state", from, to }, "state_change");
  }

  outbound(c: TurnCtx, len: number) {
    this.log.info({ ...this.base(c), step: "msg_sent", len }, "outbound");
  }

  err(c: Partial<TurnCtx>, where: string, e: unknown) {
    recordLastError(`${where}: ${(e as Error).message}`);
    this.log.error(
      { order_id: c.order_id, ieid: c.inbound_event_id, where, msg: (e as Error).message },
      "turn_error"
    );
  }
}

// Module-level last-error ring for the heartbeat to surface.
let _lastError: { at: string; msg: string } | null = null;
export function recordLastError(msg: string) {
  _lastError = { at: new Date().toISOString(), msg };
}
export function lastError() {
  return _lastError;
}
