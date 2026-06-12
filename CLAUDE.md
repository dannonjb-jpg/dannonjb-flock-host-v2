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

## Completed work (as of 2026-06-12)

| Item | Status |
|---|---|
| FIFO burst harness test | ✓ `test/fifo-burst.test.ts` |
| 4→2 mockup bug | moot — SharpCompositor emits exactly A+B |
| Compositor swap + Phase B gate | ✓ `b12f53e`; pre-commit tripwire removed |
| Stripe webhook secret rotated | ✓ 2026-06-12 |
| try/catch on `onMockupRejected` + `onRevisionNote` | ✓ 2026-06-11 |
| `confirm_asset` action + `pending_assets` in `[ctx]` | ✓ 2026-06-11 |
| Media-send `msg_sent` logging | ✓ 2026-06-12 |
| Manual Zelle/OXXO payment route | ✓ 2026-06-12; `/manual/confirm` + `/manual/pending` on localhost webhook server |
| Penn orch relay (oclaw-push.js send-only notifier, cron */5) | ✓ 2026-06-12 |
| pm2 zombie (`penn-gateway`, 3243 restarts) | ✓ deleted 2026-06-12; systemd is sole supervisor |
| penn-orch.js standalone runner | ✓ retired 2026-06-12; loud guard added; exports intact |
| SKILL_OCLAW.md (duplicate surface) | ✓ removed 2026-06-12; `oclaw-bot.js` is canonical |

## OpenClaw orch bot — built to gate, pending BotFather token

Canonical command surface: `oclaw-bot.js` (dedicated token, pm2). `SKILL_OCLAW.md` removed — it was a workaround before the dedicated bot was confirmed viable; two surfaces on different tokens is duplicate implementations, not redundancy.

`/opt/openclaw-orch/` wired and tested:
- `penn-orch.js` — pure library; `node penn-orch.js` throws with routing instructions; `runReclaim` uses `execFile` (args array, no shell) and `RECLAIM_MIN` from env — Telegram text never reaches the arg
- `oclaw-bot.js` — dedicated-token bot; guards reject missing/Penn's token by collision check
- `ecosystem.config.js` — reads token from credentials file at load time (survives `pm2 resurrect`); fails loudly if file absent; pm2 config for oclaw-bot only
- `oclaw-push.js` — cron send-only notifier (*/5, no getUpdates)

`/reclaim` classification **(b)**: separate database (`openclaw.db` ≠ `flock.db`), shells to `oclaw reclaim`, zero contact with `orders`/`payments`/`escalation`. Test: ran `--older-than 1` against live DB; result was `no active tasks` (all tasks in completed/pending state, none reclaimed, zero residue).

**To go live** (once BotFather token in hand):
```bash
# Write token as plain value — no shell export syntax, no world-readable window
install -m600 /dev/null /root/.openclaw/credentials/oclaw-bot-token
printf '%s' '<token>' > /root/.openclaw/credentials/oclaw-bot-token
# ecosystem.config.js reads the file at pm2 start — no source needed
cd /opt/openclaw-orch && pm2 start ecosystem.config.js && pm2 save
pm2 logs oclaw-bot --lines 20   # confirm masked token logged + no 409
```

## Remaining work

- **`flock-qr-field`** (pending, priority 90 — scale: lower number = sooner; 90 = lowest urgency, do last) — QR content brain field; Phase 2, deliberately deferred. Dependency chain when picked up: brain emits `qr_content` → compositor invariant #4 stops returning null → QR renders from `wa.me` link. Nothing acts on it until the brain field lands. `qr_content` absent → compositor returns null is correct behavior until then (see `sharp-compositor.ts` invariant #4).
