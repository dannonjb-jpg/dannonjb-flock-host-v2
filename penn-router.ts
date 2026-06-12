// penn-router.ts
// Penn build-mode model router. Cheap-by-default (Haiku); a task class or runtime
// signal forces smart (Sonnet). Pure, dependency-free, SDK-free (Flock D-2 discipline).
// Mirrors model-router.ts.
//
// The HARNESS calls this before/as Penn acts and issues `/model sonnet` or
// `/model default` per the decision. Penn does NOT pick her own tier:
// brain proposes, host disposes — applied to model selection.

import policy from "./penn-routing-policy.json";

export type Tier = "cheap" | "smart";

export interface PennRoutingInput {
  targetFiles?: string[];     // files the current step will read/write
  failureCount?: number;      // consecutive failed attempts at the current step
  pendingCommand?: string;    // a command about to execute, if any
  currentTier?: Tier | null;  // for the stickiness latch
  selfRequest?: boolean;      // Penn asked to escalate
}

export interface PennRoutingDecision {
  tier: Tier;
  model: string;   // the /model token: "sonnet" | "haiku"
  reason: string;  // LOG THIS — cost ratio + observability, same as Flock's router
  prompt?: string; // extra orientation to inject (failure_rescue re-check)
}

// Globs here are only exact paths or trailing `/**`. No lone `*` in the policy,
// so we just turn `**` into `.*`. Keep it that way or extend this matcher.
function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\?*]/g, "\\$&"); // escape everything incl. *
  const re = esc.replace(/\\\*\\\*/g, ".*");               // then un-escape ** -> .*
  return new RegExp("^" + re + "$");
}

function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRe(g).test(file));
}

function firstMatch(text: string, needles: string[]): string | null {
  const h = text.toLowerCase();
  for (const n of needles) if (h.includes(n.toLowerCase())) return n;
  return null;
}

export function routePenn(input: PennRoutingInput): PennRoutingDecision {
  const smart = (reason: string, prompt?: string): PennRoutingDecision => ({
    tier: "smart", model: policy.tiers.smart, reason, prompt,
  });
  const cheap = (reason: string): PennRoutingDecision => ({
    tier: "cheap", model: policy.tiers.cheap, reason,
  });

  const files = input.targetFiles ?? [];

  // 1. SAFETY: destructive command -> smart before execution. Beats everything.
  if (input.pendingCommand) {
    const danger = firstMatch(input.pendingCommand, policy.runtimeTriggers.destructive_command.patterns);
    if (danger) return smart(`destructive:${danger.trim()}`);
  }

  // 2. SAFETY: failure loop -> smart, with the re-check prompt (question the carried thread).
  if ((input.failureCount ?? 0) >= policy.runtimeTriggers.failure_rescue.n) {
    return smart("failure_rescue", policy.runtimeTriggers.failure_rescue.prompt);
  }

  // 3. TASK CLASS: any host_validation file -> smart from first token.
  //    Checked across ALL files before render: a step touching BOTH a render file
  //    and a host_validation file routes smart. The seam wins.
  for (const file of files) {
    if (matchesAny(file, policy.taskClasses.host_validation.files)) {
      return smart(`host_validation:${file}`);
    }
  }

  // 4. Self-request -> honor (cheap to do, one input not the gate).
  if (input.selfRequest) return smart("self_request");

  // 5. RENDER is an explicit cheap floor and breaks the stickiness latch on purpose.
  for (const file of files) {
    if (matchesAny(file, policy.taskClasses.render.files)) {
      return cheap(`render:${file}`);
    }
  }

  // 6. Stickiness latch (only reached when this step touches no classified file).
  if (policy.stickiness.enabled && input.currentTier === "smart") {
    return smart("sticky");
  }

  return cheap("default");
}
