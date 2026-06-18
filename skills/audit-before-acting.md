---
name: audit-before-acting
description: "Guides agents through verifying live system state before any destructive, irreversible, or migration step. Use before restarting services, running migrations, deploying, or confirming a manual payment."
---

## Overview

Before any step that cannot easily be undone — service restart, schema migration, deployment, payment confirmation — the live state must be read and confirmed safe. Irreversible steps that affect shared state are run by the operator (Dan), not the agent, unless the agent is explicitly authorized in the current session. Auditing does not rely on HANDOFF or memory; it runs the commands.

Source: CLAUDE.md §"Build discipline §2: Verify live state — never infer it"; CLAUDE.md §"Build discipline §6: Check the supervisor before touching a service"; CLAUDE.md §"Deploy guard"; DEPLOY.md §"Validation"; penn-routing-policy.json §"runtimeTriggers.destructive_command".

## When to Use

- Before `systemctl restart` or `./scripts/deploy.sh`
- Before running a SQL migration against `flock.db`
- Before any `git push` to a branch others depend on
- Before confirming a manual payment via `/manual/confirm`
- Before stopping a service during a cutover

## Process

1. Identify the irreversible action. Classify: service restart, migration, deploy, DB write, or external call.
2. For service restart / deploy: check no orders are mid-flow. `sqlite3 flock.db "SELECT state, COUNT(*) FROM orders GROUP BY state"` — DEPLOY.md §"Validation After Both Phases". Changes to money-path files (`src/brain/action-applier.ts`, `src/payments/**`, `src/store/**`, `src/ops/scheduler.ts`) require `./scripts/deploy.sh --reviewed`, not a bare `systemctl restart`. CLAUDE.md §"Deploy guard".
3. For migrations: read the migration SQL in full before running. Verify row counts inside the transaction before the old table is dropped. migrations/payments-add-revision-kind.sql §"Verify the migration succeeded — count rows must match."
4. For supervisor changes: confirm which supervisor owns the process before touching it. `systemctl status <name>` for systemd; `pm2 list` for pm2. One supervisor per process — do not add it to a second. CLAUDE.md §"Build discipline §6".
5. For destructive commands (`rm`, `DROP TABLE`, `git push -f`, `systemctl restart`, `stripe live`): escalate to Dan before executing, not after. penn-routing-policy.json §"runtimeTriggers.destructive_command — action: escalate BEFORE executing, not after."
6. For cutover: confirm the rollback path before starting the forward step. DEPLOY.md §"Rollback" documents the gateway restart path and the wa-auth caveat.
7. Agent stops at "ready to run X — audit complete" and hands to operator unless the current session has explicit authorization to proceed.

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "HANDOFF says the service was deployed successfully." | HANDOFF is a past snapshot. Run `systemctl status` to confirm the live PID and ExecStart before acting. Source: HANDOFF.md §"STATE — [VERIFIED prior session — reconfirm before next work]". |
| "It's the test environment — audit is overkill." | The test Stripe key connects to the same `flock.db` and WhatsApp session. A botched restart still drops an active order turn. |
| "I'll roll back if something goes wrong." | Some steps have no rollback: a migration that drops a table, a payment that charges a card. The audit costs one command. Source: DEPLOY.md §"Rollback" caveat on wa-auth session loss. |

## Red Flags

- `systemctl restart` run without first confirming `systemctl status` and active orders
- Migration script executed without `BEGIN`/`COMMIT` and row-count verification
- Deploy to money-path files without `--reviewed` flag on `deploy.sh`
- Agent executing a destructive step with no operator authorization in the current conversation
- "I'll check after" — the check must come before

## Verification

- `systemctl status flock-host-v2.service` shows expected PID and `active (running)` before and after restart
- `sqlite3 flock.db "SELECT state, COUNT(*) FROM orders GROUP BY state"` shows no orders stranded mid-flow
- Migration: `SELECT COUNT(*) FROM payments` after commit equals the pre-migration count from the old table
- `journalctl -u flock-host-v2 -n 20` shows clean boot log after restart with no `[ERROR]` lines
