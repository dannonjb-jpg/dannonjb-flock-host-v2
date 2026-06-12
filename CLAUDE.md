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
Physical: `intake → mockup → awaiting_decision → deposit_pending → revision → balance_pending → in_production → received → delivered → closed`
Digital:  `intake → mockup → awaiting_decision → digital_pending → revision → closed`

Plus two cross-cutting exits from any non-terminal state: `→ cancelled` (manual),
and `→ forfeited` from `{deposit_pending, revision, balance_pending}` (going-dark).

`canTransition()` in `src/domain/state-machine.ts` is the single source of truth.
Never hard-code state strings outside that file.

## Compositor swap — shipped, hook removed
`src/integrations/sharp-compositor.ts` and `src/brain/action-applier.ts` case
`request_mockup` were required to land together (Phase A = no gate; Phase B = gate
wired). That commit is `b12f53e`. The pre-commit tripwire has been removed — both
files may now change independently.

## Deploy guard
Use `./scripts/deploy.sh` instead of `systemctl restart` directly.
Changes to `action-applier.ts`, `src/payments/`, `src/store/`, or
`src/ops/scheduler.ts` require `./scripts/deploy.sh --reviewed`.

## Configured ≠ verified
**Run the test suite and show actual output before claiming something is green.**
```
npm test                          # core invariants
npx tsx test/fifo-burst.test.ts   # FIFO burst serialization
```
Last verified 2026-06-12:
- `npm test`: 18/18 passed.
- `npx tsx test/fifo-burst.test.ts`: 4/4 passed.

## Things that look wrong but are intentional
- **QR region skips (returns null) when `qr_content` absent** — brain field deferred
  to a later session. Phase 1 ships QR-less. See invariant #4 in sharp-compositor.ts.
- **Phase B asset gate is active in `onRequestMockup`** — logo must be present and
  above the print floor before mockup generation. This is correct; it shipped in
  `b12f53e` with the compositor. The old note "Phase A asset gate is absent" no
  longer applies; pulling the gate out would be a bug.
- **`src/order-store/` and `src/scheduler.ts` don't exist** — policy names; actual
  paths are `src/store/` and `src/ops/scheduler.ts`.

## Active remaining work (as of 2026-06-12)
1. ~~FIFO burst harness test~~ — done (`test/fifo-burst.test.ts`)
2. ~~4→2 mockup bug~~ — moot; SharpCompositor generates exactly A+B for variant='both'
3. ~~Compositor swap + Phase B gate~~ — done (`b12f53e`); SharpCompositor wired in `src/index.ts`, Phase B gate in `action-applier.ts` onRequestMockup; pre-commit tripwire removed
4. ~~Stripe webhook signing secret rotated 2026-06-12~~
5. Loose threads (all done):
   - ~~try/catch gap on `onMockupRejected` + `onRevisionNote` generate() calls~~ — done (2026-06-11)
   - ~~Intake follow-through (`confirm_asset`)~~ — done (2026-06-11); `confirm_asset` action wired in `actions.ts`, `action-applier.ts`; `pending_assets=N` added to `[ctx]`; SOUL contract updated
   - ~~Media-send logging gap~~ — done (2026-06-12); `msg_sent` with `{media:true,urls}` appended after `sendMedia` succeeds, before `awaiting_decision` transition
   - ~~Manual Zelle/OXXO payment route~~ — done (2026-06-12); `/manual/confirm` (POST) and `/manual/pending` (GET) on the same localhost webhook server; `listPendingManualPayments()` on Store; server now always starts (Stripe webhook still conditional on secrets)
6. ~~Penn orch Telegram bot~~ (`orch-penn-telegram`) — done (2026-06-12); Penn skill `SKILL_OCLAW.md` wired in `Penn_core/skills/`; push-only notifier `oclaw-push.js` (cron */5) uses Penn's existing token (no getUpdates conflict); no new bot needed.

## OpenClaw orch bot — built to gate, pending BotFather token

`/opt/openclaw-orch/` contains a fully-wired dedicated Telegram bot (separate token from Penn):
- `penn-orch.js` — pure library; standalone runner removed; `node penn-orch.js` throws with routing instructions
- `oclaw-bot.js` — dedicated bot entrypoint; token guard rejects missing token and Penn's token by name
- `ecosystem.config.js` — pm2 config for `oclaw-bot` only (host and Penn excluded)
- `oclaw-push.js` — cron send-only notifier (already running */5, no getUpdates)

**All command paths tested against live DB — actual output:**
- `/status` → `pending 1 (blocked 0) · active 0 · completed 3`
- `/tasks` → `no active tasks`
- `/stale` → `none stale`
- `/reclaim` → shells to `oclaw reclaim --older-than 45`; no direct orders/payments write; tables: `tasks` in `openclaw.db` only (**classification b**)
- event push cursor: 0→10 (404 expected with placeholder token)

**To go live** (once BotFather token in hand):
```bash
# Write token to credentials file — not in chat, not in repo
echo "export OCLAW_TELEGRAM_TOKEN=<token>" > /root/.openclaw/credentials/oclaw-bot-token
chmod 600 /root/.openclaw/credentials/oclaw-bot-token
source /root/.openclaw/credentials/oclaw-bot-token
cd /opt/openclaw-orch && pm2 start ecosystem.config.js && pm2 save
pm2 logs oclaw-bot --lines 20  # verify startup, no 409, no token collision error
```

## Notes for Opus — resolved

### N1 · pm2 zombie — DONE (2026-06-12)
Pre-flight confirmed: PID 328441 = systemd cgroup = port 18789 owner. pm2 was crash-looping EADDRINUSE.
Executed: `pm2 delete penn-gateway && pm2 save`. Post-check: penn-gateway absent from pm2 list, systemd still active at 17h+, port still bound to PID 328441. One supervisor (systemd). ✓

### N2 · penn-orch.js runner — DONE (2026-06-12)
Runner section removed. `node penn-orch.js` now throws with explicit routing instructions. Exports intact. `node -e "Object.keys(require(...))"` confirms library surface with no getUpdates side effect. ✓
