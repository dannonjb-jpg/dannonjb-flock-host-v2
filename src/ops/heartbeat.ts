// ops/heartbeat.ts
// §10 — periodic liveness so Penn knows the host is alive and roughly how it's doing.
// Stats are produced by an injected provider so the Store port stays lean; index.ts
// wires a concrete one against the sqlite store.

import { Notifier } from "../domain/integrations.js";
import { Clock } from "../domain/ports.js";
import { postToPennSafe } from "./escalation.js";

export interface HeartbeatStats {
  activeOrders: number; // non-terminal
  cheapTurns: number; // since last beat
  smartTurns: number; // since last beat
  lastError?: string;
}

export class Heartbeat {
  constructor(
    private d: {
      notifier: Notifier;
      clock: Clock;
      stats: () => HeartbeatStats;
    },
  ) {}

  async beat(): Promise<void> {
    const s = this.d.stats();
    const total = s.cheapTurns + s.smartTurns;
    const smartPct = total > 0 ? Math.round((s.smartTurns / total) * 100) : 0;
    const line =
      `[heartbeat ${this.d.clock.nowIso()}] up · ${s.activeOrders} active orders · ` +
      `${total} turns (${smartPct}% smart)` +
      (s.lastError ? ` · last error: ${s.lastError}` : "");
    await postToPennSafe(this.d.notifier, line, "heartbeat");
  }
}
