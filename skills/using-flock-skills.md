---
name: using-flock-skills
description: "Guides agents through selecting the right Flock discipline skill for incoming work. Use at the start of any session touching Flock state, money, assets, pricing, or testing."
---

## Overview

The nine Flock discipline skills each address a specific failure mode observed in the system. This meta-skill maps work type to the correct skill(s) and defines the order to apply them when multiple overlap.

## When to Use

At the start of any session that will modify Flock source code, configuration, the live DB, or a running service.

## Process

1. Read the task. Match it to the primary skill(s) in the routing table below.
2. Load and follow each matched skill. Where multiple skills apply, apply them in the order shown in the "Also apply" column.
3. **Money path** (any payment row, Stripe call, or manual confirm): always apply **insert-before-charge** and **cas-exactly-once** together.
4. **Any live-system action** (restart, migration, deploy): apply **audit-before-acting** first.
5. **Any new test or gate claim**: apply **negative-control-before-positive**.
6. **Any factual claim about current state** before acting on it: apply **configured-not-verified**.

| Work type | Primary skill | Also apply |
|---|---|---|
| New action handler or brain output case | brain-proposes-host-disposes | configured-not-verified |
| Payment flow, Stripe integration, webhook handler | insert-before-charge · cas-exactly-once | audit-before-acting |
| Writing to orders / payments / assets from any code | single-writer-discipline | audit-before-acting |
| Claiming a service is running / schema exists / test passes | configured-not-verified | — |
| New test, regression test, gate verification | negative-control-before-positive | configured-not-verified |
| Service restart / migration / deploy / DB write | audit-before-acting | configured-not-verified |
| Logo / media intake / compositor / mockup gate | asset-fidelity-gate | brain-proposes-host-disposes |
| Price change / new product / pricing markdown update | pricing-single-source | configured-not-verified |
| Cross-component DB access (Penn script, cron, migration) | single-writer-discipline | audit-before-acting |
| Unfamiliar task type | Read CLAUDE.md §"Build discipline" first | configured-not-verified |

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "The task is simple — no skill needed." | Simple tasks are where invariants are casually broken. A one-line edit to `action-applier.ts` still needs **brain-proposes-host-disposes**. |
| "I already know this codebase." | Skills encode what the codebase learned from live failures, not just how it works today. CLAUDE.md §"Things that look wrong but are intentional". |
| "The skills overlap — I'll use judgment." | Overlapping skills have the defined precedence in steps 3–6 above. Judgment is what the steps encode. |

## Red Flags

- Starting a session that touches money-path files without first confirming the deploy guard (CLAUDE.md §"Deploy guard")
- No skill identified for a task modifying `src/payments/`, `src/store/`, or `src/brain/action-applier.ts`
- Closing a task without satisfying the Verification section of each skill that applied

## Verification

Before marking any task complete: for each skill that applied, confirm its Verification section is satisfied and tagged `[VERIFIED]` with the supporting output.
