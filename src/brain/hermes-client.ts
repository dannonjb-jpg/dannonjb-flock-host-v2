// brain/hermes-client.ts
// Brain port + [ctx] header builder (§5) + concrete Anthropic client.
//
// AnthropicClient is the live implementation: Anthropic Messages API directly,
// SOUL contract as system prompt (loaded once at boot, cached via cache_control),
// [ctx] prepended to each user message (volatile — must not be inside cached prefix),
// conversation history reconstructed from the events table so the brain remembers
// the thread across restarts.
//
// HttpHermesClient is kept for custom / proxy deployments (just set HERMES_API_URL).

import { Order, JobSpec } from "../domain/types.js";
import { Store } from "../store/store.js";
import { AssetStore, coarseUsable } from "../store/asset-store.js";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface BrainRequest {
  sessionId: string;
  message: string;
  model: string;          // router override — passed as `model` in the API body
  contextHeader: string;  // the [ctx] line, prepended to the user message each turn
  history: ConversationTurn[];  // recent turns, oldest-first, trimmed by the host
  systemPrompt: string;   // SOUL contract text, loaded at boot
}

export interface Brain {
  /** Returns the brain's RAW output (reply + optional fenced actions block). */
  ask(req: BrainRequest): Promise<string>;
}

// ── Anthropic Messages API client ─────────────────────────────────────────────

interface AnthropicMessage {
  type: string;
  text?: string;
}
interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
interface AnthropicResponse {
  content: AnthropicMessage[];
  usage?: AnthropicUsage;
}

export class AnthropicClient implements Brain {
  constructor(
    private apiKey: string,
    private maxTokens: number = 2048,
  ) {}

  async ask(req: BrainRequest): Promise<string> {
    // Static SOUL+pricing text gets a cache breakpoint so Anthropic can cache it
    // across turns. The volatile [ctx] line travels with the user message instead —
    // any byte change in the cached prefix would invalidate it.
    const system = req.systemPrompt
      ? [{ type: "text" as const, text: req.systemPrompt, cache_control: { type: "ephemeral" as const } }]
      : undefined;

    // [ctx] at the top of the user content satisfies the SOUL contract's
    // "every turn begins with [ctx]" rule.
    const userContent = req.contextHeader
      ? `${req.contextHeader}\n\n${req.message}`
      : req.message;

    const messages: { role: "user" | "assistant"; content: string }[] = [
      ...req.history,
      { role: "user", content: userContent },
    ];

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: this.maxTokens,
        ...(system && { system }),
        messages,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as AnthropicResponse;
    if (data.usage) {
      const u = data.usage;
      console.log(`[brain] tokens in=${u.input_tokens} out=${u.output_tokens}` +
        (u.cache_creation_input_tokens ? ` cache_write=${u.cache_creation_input_tokens}` : "") +
        (u.cache_read_input_tokens ? ` cache_read=${u.cache_read_input_tokens}` : ""));
    }
    return data.content.find((b) => b.type === "text")?.text ?? "";
  }
}

// ── Custom / proxy endpoint client (kept for non-Anthropic deployments) ───────

export interface HermesConfig {
  baseUrl: string;
  apiKey?: string;
  modelHeader?: string;
}

export class HttpHermesClient implements Brain {
  constructor(private cfg: HermesConfig) {}

  async ask(req: BrainRequest): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) headers["authorization"] = `Bearer ${this.cfg.apiKey}`;
    if (this.cfg.modelHeader) headers[this.cfg.modelHeader] = req.model;

    const res = await fetch(this.cfg.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: req.sessionId,
        model: req.model,
        context: req.contextHeader,
        message: req.message,
        history: req.history,
      }),
    });
    if (!res.ok) throw new Error(`hermes ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { text?: string; reply?: string; output?: string };
    return data.text ?? data.reply ?? data.output ?? "";
  }
}

// ── [ctx] header builder (§5) ─────────────────────────────────────────────────

function collectedKeys(order: Order): string {
  const keys: string[] = [];
  if (order.client_name) keys.push("client_name");
  if (order.business_name) keys.push("business_name");
  if (order.project_type) keys.push("project_type");
  let spec: JobSpec = {};
  if (order.job_spec) {
    try { spec = JSON.parse(order.job_spec) as JobSpec; } catch { /* tolerate */ }
  }
  if (spec.specs && Object.keys(spec.specs).length > 0) keys.push("specs");
  return keys.length ? keys.join(",") : "-";
}

export function buildContextHeader(order: Order, store: Store, assetStore?: AssetStore): string {
  const mockup = order.selected_mockup ?? "-";
  const pending = store.pendingClientPaymentKind(order.order_id);

  // Price: read price_cents from job_spec. Only exposed once computed — brain sees price=-
  // until the host has a confirmed figure, then price=<amount><ccy> (e.g. 500USD, 2400MXN).
  let priceField = "-";
  if (order.job_spec) {
    try {
      const spec = JSON.parse(order.job_spec) as JobSpec;
      if (spec.price_cents && spec.price_cents > 0) {
        const ccy = (spec.currency ?? "USD").toUpperCase();
        priceField = `${Math.round(spec.price_cents / 100)}${ccy}`;
      }
    } catch { /* tolerate malformed job_spec */ }
  }

  // Rejected action: signals to brain that a prior action failed on this turn.
  // Bounded to last turn only — don't accumulate. Helps brain re-propose after transient failures.
  let rejectedField = "-";
  const lastRejection = store.getLastRejectedAction(order.order_id);
  if (lastRejection) {
    rejectedField = lastRejection; // e.g. "request_mockup", "request_payment", etc.
  }

  // Logo status — brain needs this to avoid promising mockups before the logo is on file.
  let logoField = "-";
  let pendingAssets = 0;
  if (assetStore) {
    const logo = assetStore.resolveLogo(order.whatsapp_jid, "current");
    logoField = !logo ? "no" : coarseUsable(logo) ? "yes" : "low_res";
    pendingAssets = assetStore.pendingAssets(order.whatsapp_jid).length;
  }

  return (
    `[ctx] state=${order.state} track=${order.track} mockup=${mockup} ` +
    `turn=${order.turn_count} pending_payment=${pending} ` +
    `price=${priceField} collected=${collectedKeys(order)} ` +
    `failed_pairs=${order.failed_mockup_pairs} digital_rounds=${order.digital_rounds_used} ` +
    `logo_on_file=${logoField} pending_assets=${pendingAssets} last_rejected_action=${rejectedField}`
  );
}
