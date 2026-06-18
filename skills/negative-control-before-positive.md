---
name: negative-control-before-positive
description: "Guides agents through confirming a test fails for the right reason before trusting that it passes. Use when writing regression tests, claiming a gate is verified, or interpreting a green test suite after a fix."
---

## Overview

A passing test is only meaningful if the same test was first confirmed to fail when the condition under test is absent. Without a negative control, a test may pass because it never actually exercised the failure path — not because the fix works. HANDOFF.md records "burst test negative control (5/5) committed" as an explicit shipped gate.

Source: HANDOFF.md §"Gate 2 VERIFIED + ARCHIVED: burst test negative control (5/5) committed at 26a092b"; SAFETY_GATES.md §"Testing Scenarios"; test/2a-2-empty-return.test.ts.

## When to Use

- Writing a new regression test for a bug fix
- Claiming a safety gate is verified
- Interpreting a green CI run after a fix lands
- Adding tests for a new invariant

## Process

1. Write the test to assert the failure condition (e.g., `expect(escalation).toBe('manual')` for a bridge-down scenario). Run it against the **unfixed** code — it must FAIL. This is the negative control. HANDOFF.md §"Gate 2: burst test negative control".
2. Record the failure output (test name, assertion that failed). Tag it `[NEGATIVE CONTROL CONFIRMED: <test-name> failed as expected]`.
3. Apply the fix.
4. Re-run the same test — it must now PASS. `npm test` — show the output.
5. A gate is verified only after both steps. A green test with no prior red run proves nothing about the fix.
6. For Gate 1 bridge-failure tests: the test explicitly exercises the error branch first. test/2a-2-empty-return.test.ts calls `escalateForMockupFailure()` (the failure path) and asserts `escalation='manual'` and `state='mockup'` — the negative of the happy path. SAFETY_GATES.md §"Scenario 2: Bridge returns empty".

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "The test passes after the fix — the fix clearly works." | A test can pass before and after a fix if it never reached the failing code path. Negative control proves the test is sensitive to the defect. Source: HANDOFF.md §Gate 2 pattern. |
| "I can read the fix — it's obviously correct." | SAFETY_GATES.md listed Gate 1 as "FIXED" before any test verified the fix. The test is the verifiable record; code review is not. Source: SAFETY_GATES.md §"Implementation Status — ✅ FIXED". |
| "Running the test twice doubles the time." | One extra test run costs seconds. Shipping a fix that doesn't fix the bug costs a live incident. |

## Red Flags

- Test file added in the same commit as the fix, with no record of it having failed first
- Gate claimed `[VERIFIED]` with only a passing test and no mention of negative control
- Test that only asserts the happy path without a branch exercising the failure mode
- `npm test` run only after the fix, never before

## Verification

- git log shows the test file committed before or in the same commit as the fix, with a commit message or comment noting the negative control result
- `npm test` output shows the specific test name (not just aggregate count) passing after the fix
- For Gate 1 tests: test/2a-1-bridge-down.test.ts and test/2a-2-empty-return.test.ts named individually in the run output and green
