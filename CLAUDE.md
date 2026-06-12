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
- `/root/queue/DIAGNOSTIC_PROTOCOL.md` — BUILD MODE playbook (auto-load when any trigger fires)

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
- **QR region skips (returns null) when `qr_content` absent** — correct behavior; QR link is optional (client may not have one). See invariant #4 in sharp-compositor.ts.
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
| Prompt caching | ✓ 2026-06-12; `cache_control: {type:"ephemeral"}` on system prompt block in `hermes-client.ts:129`; `[ctx]` travels with user message (not system prompt); ~4000-token SOUL+pricing prefix is well above the 2048-token cache threshold; no beta header needed (GA feature); `cache_write` / `cache_read` logged per turn |

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

## Build discipline — mandatory before touching any code

These rules apply to every session, every worker, every task. No exceptions.

### 1. Map before you touch
Read every file you will modify before writing a single line. If you haven't read it,
you don't know what's in it — your training-data memory of it is a guess.
- Use `Read` on the file. Use `grep` or `find` if you don't know the path.
- For a feature area, read the spec doc listed under "Key docs" above first.

### 2. Verify live state — never infer it
Before making any claim about what's running, what schema exists, or what a file contains:
```bash
systemctl status flock-host-v2.service   # is it running?
pm2 list                                 # what does pm2 own?
sqlite3 flock.db ".schema orders"        # what does the table actually look like?
journalctl -u flock-host-v2 -n 50        # what did it actually log?
```
"I think it's X" based on memory is not a verification. Run the command.

### 3. No assuming — trace the actual path
If you're not sure how two files connect, grep for the import or the function name.
If you're not sure which branch runs, read the conditional. Never assume a code path
is the hot one; trace it from the entry point.

### 4. Understand invariants before touching the area
Read the "Prime invariant" and "Things that look wrong but are intentional" sections
above before touching any file in that area. Breaking an invariant silently stalls
a real customer order.

### 5. One change at a time, then verify
Make the smallest change that moves toward the goal. Then:
- Run `npm test` (or the relevant test) and read the output.
- Check the live log if the service is running.
- Confirm the change actually took effect before moving to the next.
Never stack two unverified changes.

### 6. Check the supervisor before touching a service
Before stopping, starting, or restarting anything:
```bash
systemctl status <name>   # owned by systemd?
pm2 list                  # owned by pm2?
```
- systemd owns: `flock-host-v2`, `openclaw-penn`
- pm2 owns: `oclaw-bot`, `flock-mockup-worker`
Never add a process to both supervisors. One supervisor per process.

### 7. Deploy guard for money-path files
Changes to these files require `./scripts/deploy.sh --reviewed`, not a bare restart:
- `src/brain/action-applier.ts`
- `src/payments/**`
- `src/store/**`
- `src/ops/scheduler.ts`

### 8. Read the actual error
When something fails, read the full log line — don't assume you know why. The real
cause is frequently not what the error summary suggests.

### BUILD MODE auto-engage (fires on any trigger)

**Triggers:** any file edit (`.py/.ts/.js/.json`), service restart, config change, debug work.

When a trigger fires:
1. Read `/root/queue/DIAGNOSTIC_PROTOCOL.md` in full — follow its 6-step playbook.
2. Set a `.hot` sidecar next to your claimed task file:
   ```bash
   touch /root/queue/claimed/NNN-slug.worker.hot
   ```
3. Work under diagnostic discipline until done.

**Heartbeat — keep your claimed file fresh while alive:**

Touch your claimed file at every major step (after each file read, edit, or test run):
```bash
touch /root/queue/claimed/NNN-slug.worker.md
```
Staleness = mtime older than sweep threshold. A live session stays fresh via touches.
A crashed session goes stale naturally. Do NOT rely on the sweep threshold for task
duration — touch frequently and the threshold won't matter.

**Before moving task to done/ (mandatory writeback):**
1. Append a `## BUILD SESSION — YYYY-MM-DD HH:MM` block to the task file (facts, lessons, unresolved).
2. Remove the `.hot` sidecar.
3. Move task to done/:
   ```bash
   rm /root/queue/claimed/NNN-slug.worker.hot
   mv /root/queue/claimed/NNN-slug.worker.md /root/queue/done/NNN-slug.worker.md
   ```

**Session start — run the sweep with `--boot` (cron omits this flag):**
```bash
bash /root/queue/queue-sweep.sh --boot
```
`--boot` adds opus-sessions/ crash detection. Cron omits it: Opus has no heartbeat between turns,
so cron scanning opus-sessions/ would false-alarm on every human pause. Boot-time is the right
signal — an orphaned `.in-progress.opus.md` still present when the next session starts is a real
crash; a paused session finalizes its own record on resume.
Reclaims stale worker claims → `pending/`. Routes `.hot` orphans → `claimed-review/` + Telegram.

**Queue task YAML frontmatter (machine-readable without .json):**
```markdown
---
type: build | feature | investigation
priority: NNN
worker: penn | cj | opus
requires: slug-of-dependency
---
```
Penn writes queue task files as `.md` with this frontmatter — parseable, never a `.json` (`.json` is in the trigger set).

---

## Remaining work

- **`flock-qr-field`** (pending, priority 90 — scale: lower number = sooner; 90 = lowest urgency, do last) — QR content brain field; Phase 2, deliberately deferred. Dependency chain when picked up: brain emits `qr_content` → compositor invariant #4 stops returning null → QR renders from `wa.me` link. Nothing acts on it until the brain field lands. `qr_content` absent → compositor returns null is correct behavior until then (see `sharp-compositor.ts` invariant #4).

## Shared work queue (Penn + cj)

Workers share `/root/queue/` — a three-state directory queue. File moves are atomic so
claiming is lock-free: no daemon, no race condition.

```
/root/queue/pending/   ← available work
/root/queue/claimed/   ← in progress (owned by one worker)
/root/queue/done/      ← finished
```

### File naming

`NNN-slug.md` — NNN is a zero-padded priority number (lower = sooner), slug is the task
name. Example: `090-flock-qr-field.md`.

### Claiming a task (atomic, lock-free)

Pick the lowest-numbered file in `pending/` and `mv` it to `claimed/` with your worker
name appended:

```bash
# Penn claims:
mv /root/queue/pending/090-flock-qr-field.md /root/queue/claimed/090-flock-qr-field.penn.md
# cj claims:
mv /root/queue/pending/090-flock-qr-field.md /root/queue/claimed/090-flock-qr-field.cj.md
```

If two workers race, only one `mv` succeeds — the loser gets "No such file or directory"
and moves on to the next pending file. That's the double-work guard.

### Completing a task

Move from `claimed/` to `done/` when finished:

```bash
mv /root/queue/claimed/090-flock-qr-field.cj.md /root/queue/done/090-flock-qr-field.cj.md
```

### Session protocol

When you start a session working on this project:
1. `ls /root/queue/pending/` — see what's available
2. `ls /root/queue/claimed/` — see what the other worker has in flight (don't duplicate)
3. Claim the lowest-numbered unclaimed task via atomic `mv`
4. Do the work; move to `done/` when complete; repeat
