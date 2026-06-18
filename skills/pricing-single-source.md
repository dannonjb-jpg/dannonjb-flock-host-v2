---
name: pricing-single-source
description: "Guides agents through keeping pricing.ts as the sole source of truth for client prices. Use when adding a product, changing a rate, updating the pricing markdown, or debugging a price discrepancy."
---

## Overview

`src/pricing/pricing.ts` is the single source of truth for all client prices. `flock-soul-pricing.md` is auto-generated from it via `npm run regen-pricing` and must never be hand-edited. The deleted `src/pricing/product_config.json` was a parallel config that contained a stale `$75 revision cost` — its removal eliminated a live drift risk. The brain reads pricing from the system prompt (the generated markdown) and never computes prices itself.

Source: src/pricing/pricing.ts header §"CLIENT PRICES — single source of truth"; flock-soul-pricing.md §"AUTO-GENERATED" header comment; HANDOFF.md §"flock-soul-pricing.md is now AUTO-GENERATED — never hand-edit"; flock-soul-contract.md §"Never compute or quote a price yourself — ever."

## When to Use

- Adding or changing a product price
- Adding a new product type or removing an existing one
- Updating `flock-soul-pricing.md` (always via regen, never direct edit)
- Debugging a discrepancy between what the brain quotes and what the host charges

## Process

1. Edit `src/pricing/pricing.ts` only. Constants (`UNIT_BASE_PRICES`, `SQFT_TIERS`, `UNIT_LADDER`, `CUT_VINYL_BASE_PER_SQFT`, `UV_UPCHARGE_PER_SQFT`, etc.) are the authoritative numbers. src/pricing/pricing.ts header.
2. Run `npm run regen-pricing` after any pricing change. This regenerates `flock-soul-pricing.md` from the TypeScript constants. HANDOFF.md §"run `npm run regen-pricing` after changing pricing.ts".
3. Verify the generated markdown reflects the change: `grep <changed-value> flock-soul-pricing.md`.
4. Run `npm test` — test/pricing.test.ts locks expected computed prices. A failing pricing test means either the test or the intended change is wrong; resolve before proceeding.
5. Do not add a second config file (JSON, YAML, env var) containing price data at runtime. This recreates the drift vector that `product_config.json` caused. Source: commit 341521c: "Dead code purge + anti-drift: Delete src/pricing/product_config.json ($75 revision cost lived here, not in code)."
6. The brain never computes prices. flock-soul-contract.md §"Never compute or quote a price yourself — ever." + §"The pricing tables in your system prompt are reference material for understanding the business. You do not use them to calculate." The host's `computePrice()` is the only runtime caller of pricing.ts.
7. Dan-approval products go to escalation, not auto-quote. Add to the `DAN_APPROVAL` set in pricing.ts. Brain emits `escalate`; host notifies Penn. src/pricing/pricing.ts §"Dan-approval products".

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "I'll update the markdown directly — it's faster." | The next `npm run regen-pricing` overwrites the hand-edit silently. Source: flock-soul-pricing.md §"AUTO-GENERATED — never hand-edit". |
| "A JSON config is easier for Dan to update without touching TypeScript." | This is how `product_config.json` was born and how the `$75 revision bug` lived undetected. Source: commit 341521c rationale. |
| "The brain can estimate from the markdown tables — close enough for now." | "Close enough" breaks trust when `[ctx].price` corrects the brain's stated figure mid-conversation. Source: flock-soul-contract.md §"Never compute or quote a price yourself". |

## Red Flags

- `flock-soul-pricing.md` committed with changes that do not come from `regen-pricing` output
- Any file other than `pricing.ts` containing price constants referenced at runtime
- Brain output quoting a price different from `[ctx].price`
- `npm test` pricing suite failing after a price change
- `<!-- AUTO-GENERATED` comment absent from `flock-soul-pricing.md` header

## Verification

- `grep "AUTO-GENERATED" flock-soul-pricing.md` — header comment present
- `npm run regen-pricing && git diff flock-soul-pricing.md` — no unexpected changes (clean regen)
- `npm test` — test/pricing.test.ts: all pricing assertions pass with counts shown
- `SELECT job_spec FROM orders WHERE order_id=?` → parse `price_cents` and confirm it matches `computePrice()` output for the same `PricingInputs`
