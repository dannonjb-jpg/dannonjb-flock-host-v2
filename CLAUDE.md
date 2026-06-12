# Flock Host v2 — Claude Code context

## What this is
Bespoke Node.js/TypeScript WhatsApp-to-Anthropic bot for a print/mockup business.
Owned by Dan (@dannonjb). Stack: tsx, SQLite (WAL), Baileys, Stripe, Sharp.

## Key docs (read these before touching the relevant area)
- @flock-soul-contract.md — the SOUL contract; brain output format and intent taxonomy
- @flock-soul-pricing.md — pricing tables; only source of truth for price_cents
- @flock-asset-store.md — asset store schema and ingestion rules
- @penn-routing-policy.json — model routing tiers and coupling enforcement rules
- @DEPLOY.md — deployment checklist and staging procedure

## Prime invariant — do not break without escalating
**Brain proposes, host disposes.** The AI never mutates state or touches money.
All state transitions and payment operations are performed by host code after
validating brain output. This is §4 of the host spec; every handler in
`action-applier.ts` enforces it.

## State machine
`intake → mockup → awaiting_decision → deposit_pending → revision → balance_pending → in_production`
Digital track: `intake → mockup → awaiting_decision → digital_pending → revision → closed`

`canTransition()` in `src/domain/state-machine.ts` is the single source of truth.
Never hard-code state strings outside that file.

## Coupling rules (enforced by git pre-commit hook)
`src/integrations/sharp-compositor.ts` and `src/brain/action-applier.ts` case
`request_mockup` **must land in the same commit**. The Phase A/B split is
intentional — Phase A ships ungated, Phase B adds the asset gate. Do not
"fix" this by splitting them.

## Deploy guard
Use `./scripts/deploy.sh` instead of `systemctl restart` directly.
Changes to `action-applier.ts`, `src/payments/`, `src/store/`, or
`src/ops/scheduler.ts` require `./scripts/deploy.sh --reviewed`.

## Configured ≠ verified
**Run the test suite and show actual output before claiming something is green.**
```
npm test                          # core invariants (17/18; one pre-existing stub failure)
npx tsx test/fifo-burst.test.ts   # FIFO burst serialization (4/4)
```
The host lifecycle test (`getLastRejectedAction`) is a pre-existing stub gap —
not introduced by recent changes.

## Things that look wrong but are intentional
- **QR region skips (returns null) when `qr_content` absent** — brain field deferred
  to a later session. Phase 1 ships QR-less. See invariant #4 in sharp-compositor.ts.
- **Phase A asset gate is absent** — correct. Gate lands with Phase B (compositor swap).
  The compositor and gate are a coupled atomic change by design.
- **`src/order-store/` and `src/scheduler.ts` don't exist** — policy names; actual
  paths are `src/store/` and `src/ops/scheduler.ts`.

## Active remaining work (as of 2026-06-11)
1. ~~FIFO burst harness test~~ — done (`test/fifo-burst.test.ts`)
2. ~~4→2 mockup bug~~ — moot; SharpCompositor generates exactly A+B for variant='both'
3. ~~Compositor swap + Phase B gate~~ — done (`b12f53e`); SharpCompositor wired in `src/index.ts`, Phase B gate in `action-applier.ts` onRequestMockup; pre-commit tripwire removed
4. Loose threads: manual Zelle/OXXO route, media-send logging gap, intake follow-through
5. **Stripe webhook signing secret was pasted in chat — rotate it before next prod deploy**
