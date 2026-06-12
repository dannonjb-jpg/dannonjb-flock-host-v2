// domain/phase.ts
// §4 step 4: derive the router `phase` from order state + flags BEFORE calling
// selectModel. Phase is the most trustworthy smart/cheap signal because the host
// owns order state. Returns undefined when no phase applies, so the router falls
// through to its friction/complexity/stickiness rules.
//
// The policy's smartPhases are: first_contact, revision_loop, dispute,
// negotiation, quote_objection. Of these, three are deterministically derivable
// from host state; negotiation/quote_objection require a signal the host does not
// own yet (they remain reachable via the router's friction keywords). See README D-5.

import { Order } from "./types.js";

export function derivePhase(order: Order): string | undefined {
  if (order.dispute_flag === 1) return "dispute";
  if (order.state === "intake" && order.turn_count <= 1) return "first_contact";
  if (order.state === "revision") return "revision_loop";
  return undefined;
}
