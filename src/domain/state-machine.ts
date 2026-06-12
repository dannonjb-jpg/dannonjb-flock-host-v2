// domain/state-machine.ts
// §6 of the build spec, encoded verbatim. `state` is PIPELINE POSITION ONLY.
// dormancy / escalation / dispute are orthogonal overlays handled elsewhere — they
// never appear here and never overwrite `state`.
//
// Any transition not listed is rejected and logged. The host is the sole authority
// on state; the brain proposes intents, never state names.

import { OrderState, TERMINAL_STATES } from "./types.js";

// Adjacency list. Read each entry as "from -> [allowed to...]".
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  intake: ["mockup"],
  mockup: ["awaiting_decision"],
  // mockup target = regen a rejected pair
  awaiting_decision: ["deposit_pending", "digital_pending", "mockup"],
  deposit_pending: ["revision"],
  digital_pending: ["revision"],
  // balance = physical approved; closed = digital done
  revision: ["revision", "balance_pending", "closed"],
  balance_pending: ["in_production"],
  in_production: ["received"],
  received: ["delivered"],
  delivered: ["closed"],
  closed: [],
  cancelled: [],
  forfeited: [],
};

// Forfeit is reachable only from these positions (going-dark rules, §8).
const FORFEITABLE: ReadonlySet<OrderState> = new Set<OrderState>([
  "deposit_pending",
  "revision",
  "balance_pending",
]);

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Is `from -> to` a legal pipeline transition?
 * Encodes the explicit table plus the two cross-cutting rules from §6:
 *   - any non-terminal state -> cancelled  (manual)
 *   - {deposit_pending|revision|balance_pending} -> forfeited (going-dark)
 */
export function canTransition(from: OrderState, to: OrderState): boolean {
  if (from === to) {
    // Self-loop only where the table allows it (revision -> revision).
    return TRANSITIONS[from].includes(to);
  }
  if (to === "cancelled") return !isTerminal(from);
  if (to === "forfeited") return FORFEITABLE.has(from);
  return TRANSITIONS[from].includes(to);
}

/** Throwing guard for call sites that have already validated intent legality. */
export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal transition ${from} -> ${to}`);
  }
}

export const _internals = { TRANSITIONS, FORFEITABLE };
