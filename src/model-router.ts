// model-router.ts
// Cheap-by-default, smart-when-it-matters model selection for the Flock Node host.
//
// Pure and side-effect-free: takes one turn's context, returns a routing decision.
// The host calls this BEFORE invoking the Hermes brain, then passes decision.model
// as a per-request override (API server `model` field / X-Hermes-Model header,
// or `hermes -z --model <model>`). It does NOT call Hermes itself.
//
// Policy lives in routing-policy.json so you can tune triggers without touching logic.
// Hermes's own fallback_model is uptime insurance (failure only); this is the
// quality/cost router. They are independent and both useful.

import policy from "./routing-policy.json";

export type Tier = "cheap" | "smart";

export interface RoutingInput {
  message: string;            // inbound client message text
  phase?: string;             // conversation/order phase from the host's order DB (most reliable signal)
  currentTier?: Tier | null;  // tier used so far in this conversation (drives stickiness)
  forceTier?: Tier | null;    // explicit override from Dan/system
}

export interface RoutingDecision {
  tier: Tier;
  model: string;
  reason: string;             // why — LOG THIS for cost ratio + observability
}

function countQuestions(s: string): number {
  return (s.match(/\?/g) || []).length;
}

function firstMatch(text: string, needles: string[]): string | null {
  const h = text.toLowerCase();
  for (const n of needles) if (h.includes(n.toLowerCase())) return n;
  return null;
}

export function selectModel(input: RoutingInput): RoutingDecision {
  const { message, phase, currentTier, forceTier } = input;
  const smart = (reason: string): RoutingDecision => ({ tier: "smart", model: policy.tiers.smart, reason });
  const cheap = (reason: string): RoutingDecision => ({ tier: "cheap", model: policy.tiers.cheap, reason });

  // 1. Explicit override always wins.
  if (forceTier === "smart") return smart("forced");
  if (forceTier === "cheap") return cheap("forced");

  const text = (message ?? "").trim();
  const trivial = text.length <= policy.trivialMaxChars;

  // 2. Friction/escalation language -> smart. (Upstream should also weigh a Penn escalation.)
  const friction = firstMatch(text, policy.frictionKeywords);
  if (friction) return smart(`friction:${friction}`);

  // 3. Phase-based -> the trustworthy signal, because the host owns order state.
  if (phase && policy.smartPhases.includes(phase)) return smart(`phase:${phase}`);
  // 3b. Critical phase: mockup state requires reasoning (reject/accept/re-propose after failures).
  if (phase === "mockup") return smart("phase:mockup");

  // 4. Complexity heuristics -> rough proxy only; treat as a backstop to phase.
  if (text.length > policy.complexity.smartIfCharsOver) return smart("complexity:length");
  if (countQuestions(text) > policy.complexity.smartIfQuestionsOver) return smart("complexity:questions");
  const uncertain = firstMatch(text, policy.complexity.uncertaintyMarkers);
  if (uncertain) return smart(`complexity:uncertainty:${uncertain}`);

  // 5. Stickiness -> once a conversation is smart, stay smart so the "designer's"
  //    voice doesn't visibly drop mid-thread. Trivially short turns may fall back to cheap.
  if (policy.stickiness.enabled && currentTier === policy.stickiness.latchTier && !trivial) {
    return smart("sticky");
  }

  // 6. Default.
  return cheap("default");
}
