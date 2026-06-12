// brain/actions.ts
// The semantic intents the brain may PROPOSE (§5 / SOUL "Action vocabulary").
// The brain emits these, never raw state names; the host owns every transition.
//
// This module also parses the brain's raw output into { reply, actions }, stripping
// the fenced `actions` block so the client only ever sees natural language. Malformed
// JSON means the host cannot act (the order stalls rather than mis-acting) — we keep
// the reply text, drop the actions, and surface a parseError for logging.

export type Track = "physical" | "digital";
export type MockupVariant = "A" | "B" | "both";
export type MockupWhich = "A" | "B";
export type ClientPaymentKind = "deposit" | "balance" | "digital";
export type EscalateReason = "friction" | "supplier" | "manual";

export type Action =
  | { type: "collect"; fields: Record<string, unknown> }
  | { type: "set_track"; track: Track }
  | { type: "request_mockup"; variant: MockupVariant; brief?: string }
  | { type: "select_mockup"; which: MockupWhich }
  | { type: "mockup_rejected" }
  | { type: "request_payment"; kind: ClientPaymentKind }
  | { type: "revision_note"; note: string }
  | { type: "approve_for_print" }
  | { type: "digital_complete" }
  | { type: "escalate"; reason: EscalateReason; summary?: string }
  | { type: "cancel"; reason: string };

export interface ParsedTurn {
  /** Client-facing natural language, with the actions block stripped. */
  reply: string;
  /** [SILENT] sentinel → no message should be sent this turn. */
  silent: boolean;
  /** Valid, typed intents in emission order. */
  actions: Action[];
  /** Raw entries that failed validation (logged; never acted on). */
  rejected: unknown[];
  /** Set if the actions block existed but was not valid JSON. */
  parseError?: string;
}

function isTrack(v: unknown): v is Track {
  return v === "physical" || v === "digital";
}
function isVariant(v: unknown): v is MockupVariant {
  return v === "A" || v === "B" || v === "both";
}
function isWhich(v: unknown): v is MockupWhich {
  return v === "A" || v === "B";
}
function isClientPaymentKind(v: unknown): v is ClientPaymentKind {
  return v === "deposit" || v === "balance" || v === "digital";
}
function isEscalateReason(v: unknown): v is EscalateReason {
  // Brain may NOT emit 'mockup_pairs' — that escalation is host-derived (§5).
  return v === "friction" || v === "supplier" || v === "manual";
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one raw object into a typed Action, or null if invalid. */
export function coerceAction(raw: unknown): Action | null {
  if (!isObj(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "collect":
      return isObj(raw.fields) ? { type: "collect", fields: raw.fields } : null;
    case "set_track":
      return isTrack(raw.track) ? { type: "set_track", track: raw.track } : null;
    case "request_mockup":
      if (!isVariant(raw.variant)) return null;
      return typeof raw.brief === "string"
        ? { type: "request_mockup", variant: raw.variant, brief: raw.brief }
        : { type: "request_mockup", variant: raw.variant };
    case "select_mockup":
      return isWhich(raw.which) ? { type: "select_mockup", which: raw.which } : null;
    case "mockup_rejected":
      return { type: "mockup_rejected" };
    case "request_payment":
      return isClientPaymentKind(raw.kind) ? { type: "request_payment", kind: raw.kind } : null;
    case "revision_note":
      return typeof raw.note === "string" ? { type: "revision_note", note: raw.note } : null;
    case "approve_for_print":
      return { type: "approve_for_print" };
    case "digital_complete":
      return { type: "digital_complete" };
    case "escalate":
      if (!isEscalateReason(raw.reason)) return null;
      return typeof raw.summary === "string"
        ? { type: "escalate", reason: raw.reason, summary: raw.summary }
        : { type: "escalate", reason: raw.reason };
    case "cancel":
      return typeof raw.reason === "string" ? { type: "cancel", reason: raw.reason } : null;
    default:
      return null;
  }
}

// The canonical label the brain SHOULD use.
const ACTIONS_FENCE = /```actions\s*([\s\S]*?)```/i;

// Belt-and-suspenders: any fenced block whose content is (or opens like) a JSON array.
// These are ALWAYS stripped from the client-facing reply — even if we can't parse them —
// so raw JSON never reaches the client when the brain uses a non-standard fence label
// (e.g. ```json or an unlabeled fence). If no canonical block was found, we also attempt
// to parse this as the actions source.
const JSON_ARRAY_FENCE = /```[^\n`]*\n?\s*(\[[\s\S]*?\])\s*\n?```/g;

function stripAllActionFences(text: string): { cleaned: string; fallbackJson: string | null } {
  // Remove the canonical fence first (may be absent).
  const cleaned1 = text.replace(ACTIONS_FENCE, "");
  // Collect the first JSON-array fence content as a potential fallback, then strip all.
  let fallbackJson: string | null = null;
  const cleaned2 = cleaned1.replace(JSON_ARRAY_FENCE, (_match, cap: string) => {
    if (fallbackJson === null) fallbackJson = cap.trim();
    return "";
  });
  return { cleaned: cleaned2.trim(), fallbackJson };
}

export function parseBrainOutput(raw: string): ParsedTurn {
  const canonicalMatch = raw.match(ACTIONS_FENCE);
  const { cleaned, fallbackJson } = stripAllActionFences(raw);
  const reply = cleaned;
  const silent = reply === "[SILENT]" || reply === "";

  // Prefer canonical fence; fall back to any JSON-array fence if the brain mislabeled.
  const jsonText = canonicalMatch ? (canonicalMatch[1] ?? "").trim() : (fallbackJson ?? "");

  if (!jsonText) {
    return { reply: silent ? "" : reply, silent, actions: [], rejected: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return {
      reply: silent ? "" : reply,
      silent,
      actions: [],
      rejected: [],
      parseError: `invalid JSON in actions block: ${(e as Error).message}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      reply: silent ? "" : reply,
      silent,
      actions: [],
      rejected: [parsed],
      parseError: "actions block was not a JSON array",
    };
  }

  const actions: Action[] = [];
  const rejected: unknown[] = [];
  for (const entry of parsed) {
    const a = coerceAction(entry);
    if (a) actions.push(a);
    else rejected.push(entry);
  }
  return { reply: silent ? "" : reply, silent, actions, rejected };
}
