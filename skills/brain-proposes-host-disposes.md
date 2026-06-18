---
name: brain-proposes-host-disposes
description: "Guides agents through validating that the host — not the brain — commits every state and money change. Use when writing or reviewing action handlers, or debugging why a brain intent had no visible effect."
---

## Overview

The brain (Anthropic LLM) emits semantic intents only; it never mutates DB state, touches money, or sends messages. The host validates each intent against the state machine and authorization rules, then commits or rejects it with a durable event row. This is the prime invariant of the system.

Source: CLAUDE.md §"Prime invariant"; flock-soul-contract.md §"Machine"; src/brain/action-applier.ts header.

## When to Use

- Writing or reviewing a new case in `action-applier.ts`
- Debugging why a brain action appeared to have no effect
- Evaluating whether new logic belongs in brain output vs. host code

## Process

1. Brain emits an `actions` JSON array of semantic intents — flock-soul-contract.md §"Action vocabulary". Brain output is untrusted text; the host parses it via `parseBrainOutput()`.
2. Host calls `ActionApplier.applyAll(orderId, actions, inboundEventId)`. The order row is re-read between each action because earlier actions can advance state. src/brain/action-applier.ts:applyAll().
3. For each action, `applyOne()` checks: (a) order exists, (b) order is non-terminal via `isTerminal()`, (c) the specific state-machine or authorization precondition for that action type. src/brain/action-applier.ts:applyOne().
4. If valid, host calls `store.transition()` or `store.patchOrder()` — never the brain. Brain never holds a DB handle.
5. If rejected, action is logged with reason. `last_rejected_action` surfaces in the next `[ctx]` header so the brain can correct course. flock-soul-contract.md §"[ctx] header — last_rejected_action".
6. Every committed transition writes an `events` row (`actor='flock'`, `type='state_change'`). src/store/sqlite-store.ts:transition().

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "The brain output is already shaped by the prompt — host checks are redundant." | Prompt adherence is probabilistic. The host check is the hard gate. Source: action-applier.ts header: "Never trusts an intent blindly." |
| "The brain knows the order state — let it emit `set_state` directly." | `set_state` is not in the action vocabulary. `canTransition()` in state-machine.ts owns the graph; the brain proposes intents. Source: flock-soul-contract.md §"Action vocabulary". |
| "Validating every action adds overhead on the happy path." | A single unchecked action silently stalls a real customer order. Source: CLAUDE.md §"Prime invariant — do not break without escalating". |

## Red Flags

- Any code path calling `store.transition()` or `store.patchOrder()` from within brain-output parsing, outside `action-applier.ts`
- A new action type added to flock-soul-contract.md §"Action vocabulary" with no matching case in `applyOne()`'s switch statement
- `applied` list growing while the order `state` column does not change (handler returned null without committing)

## Verification

- `SELECT state FROM orders WHERE order_id = ?` before and after a turn — state only changes after a host-committed action
- `SELECT actor, type, payload FROM events WHERE order_id = ? AND type = 'state_change'` — every transition has `actor='flock'`
- `npm test` — test/core.test.ts exercises the host-disposes invariant
