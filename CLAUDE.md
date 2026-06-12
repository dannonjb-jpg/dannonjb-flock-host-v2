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

---

## Notes for Opus — review and decide

### N1 · pm2/systemd dual-supervision of Penn (action required)

`pm2 list` shows `penn-gateway` (id=1) with **3,243 restarts** and status `waiting`. Root cause: the systemd unit `openclaw-penn.service` owns port 18789 (running, healthy, 16h+ uptime). pm2 starts the same process, hits `EADDRINUSE`, crashes, repeats forever.

**Violation:** the no-dual-supervision rule (one supervisor only). pm2 is the zombie; systemd is the authoritative owner.

**Proposed fix:** `pm2 delete penn-gateway && pm2 save` — removes the zombie entry. Systemd continues as sole supervisor. Restart policy and logging stay in the unit file.

**Opus decision needed:** confirm the systemd unit is the intended supervisor, then authorize `pm2 delete penn-gateway`. Destructive (removes pm2 entry); reversible (can re-add if needed).

---

### N2 · `penn-orch.js` standalone runner — now redundant

`/opt/openclaw-orch/penn-orch.js` was written with a standalone runner (getUpdates loop + setInterval event push + command handler). The `orch-penn-telegram` task is now closed via:
- Penn skill (`SKILL_OCLAW.md`) — handles `/oclaw-*` commands inside Penn's own getUpdates loop
- `oclaw-push.js` cron — push-only event notifier using Penn's token

`penn-orch.js`'s standalone runner is therefore **unused and should not be started** (would create a second getUpdates consumer on Penn's token). The exported functions (`queueSummary`, `activeTasks`, etc.) remain importable if ever needed.

**Opus decision needed:** should `penn-orch.js` have its standalone runner section removed entirely (prevent accidental `node penn-orch.js` from fighting Penn), or just leave the existing comment warning in place?
