---
name: configured-not-verified
description: "Guides agents through proving a claim with live-system evidence before reporting it as true. Use whenever making a claim about what is running, what schema exists, what a file contains, or whether tests pass."
---

## Overview

A claim backed only by reading config files, code, or session memory is not verified. Verification requires observable evidence from the running system: command output, DB query result, log line, or test runner output with the actual counts shown. HANDOFF.md's `[VERIFIED]`/`[UNVERIFIED]` tagging pattern makes this auditable across sessions.

Source: CLAUDE.md §"Configured ≠ verified"; CLAUDE.md §"Build discipline §2: Verify live state — never infer it"; HANDOFF.md §proof-tagging pattern.

## When to Use

- Before claiming a service is running or stopped
- Before claiming a schema has (or lacks) a particular column
- Before claiming tests pass
- Before claiming a config value is active in the live process
- Before claiming a deployment took effect

## Process

1. State the claim precisely before attempting to verify it.
2. Choose the evidence command:
   - Service running/stopped: `systemctl status <name>` — CLAUDE.md §"Build discipline §2"
   - Schema: `sqlite3 flock.db ".schema orders"` — CLAUDE.md §"Build discipline §2"
   - Tests: `npm test` — read the actual pass/fail output, not the last-known result — CLAUDE.md §"Configured ≠ verified"
   - Log behavior: `journalctl -u flock-host-v2 -n 50` — CLAUDE.md §"Build discipline §2"
   - Env var active in live process: `systemctl show <name> -p Environment` — SAFETY_GATES.md §"Gate 2 — Verification"
3. Run the command. Read full output — not just the status line. CLAUDE.md §"Build discipline §8: Read the actual error".
4. Tag the claim `[VERIFIED]` with the command and an output excerpt, or `[UNVERIFIED]` with what command would be needed. HANDOFF.md proof-tagging pattern.
5. Do not stack a second change on top of an unverified one. CLAUDE.md §"Build discipline §5: One change at a time, then verify".

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "The config says the key is set — that's enough." | `systemctl show` has revealed variables present in the unit file but absent from the live environment. Run the command. Source: CLAUDE.md §"Configured ≠ verified". |
| "I just ran the tests in a previous session." | The previous session is gone. Show the current output. Source: CLAUDE.md §"Last verified 2026-06-12: 18/18 passed" — note the date is explicit, not a standing truth. |
| "The HANDOFF says it was verified." | HANDOFF is a snapshot of a past state. Re-verify before acting. Source: HANDOFF.md §"DID NOT VERIFY" section — items explicitly left unverified even at time of writing. |

## Red Flags

- Claiming a service is active without running `systemctl status`
- Claiming tests are green without showing `npm test` output from the current session
- A `[VERIFIED]` tag on a claim with no supporting command output
- Phrases like "it should be X", "I believe X", or "last time it was X" used as the basis for a state-changing action

## Verification

The evidence is the verification — the command output is the proof. If a claim cannot be verified with a read-only command, it must be tagged `[UNVERIFIED]` with the blocking reason noted.

- `npm test` output shows numeric pass/fail counts matching the expected total — CLAUDE.md §"Configured ≠ verified: 18/18 passed"
- `systemctl status flock-host-v2.service` shows `active (running)` with the expected PID and ExecStart path
