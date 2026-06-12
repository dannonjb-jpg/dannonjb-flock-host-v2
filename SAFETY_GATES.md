# Flock v2 Safety Gates — Critical Invariants

## Gate 1: Present-Before-Advance (Mockup Safety)

**The Problem:** If the mockup bridge fails or returns empty `{}`, the host must NOT advance the order to `awaiting_decision`. Otherwise, the customer sees no images but the order moves forward as if mockup was successful.

**Invariant:** `onRequestMockup()` must verify that `urls` is non-empty BEFORE pushing to presentations queue. If empty, escalate to Penn instead of presenting.

**Current Code Status:**
- ✅ onRequestMockup() transitions to mockup state immediately (correct — "generating" placeholder)
- ✅ Calls generate() with variant + brief
- ⚠️ **BUG:** Does NOT check if urls is empty before pushing to presentations
- ⚠️ **BUG:** Downstream still transitions to awaiting_decision even if urls = {}

**Implementation Status:** ✅ FIXED

See `/root/flock-host-v2/ONREQUESTMOCKUP_FIXED.ts` for the complete corrected function.

**Three gaps closed:**
1. **Throws (not just empty):** try/catch wraps generate() to catch bridge-down (ECONNREFUSED)
2. **Full escalation path:** Sets orders.escalation overlay + appends event + posts to Penn (guarded)
3. **Escalation-clear on recovery:** Checks recent event detail, clears transient bridge failures only

**Key invariants enforced:**
- Try/catch → escalation="manual" with detail={mockup_bridge_failed | mockup_empty}
- postToPenn wrapped in try/catch (Telegram is best-effort, don't crash on network failure)
- Escalation cleared conditionally: only if recent event shows this function set it (payload.detail check)
- Order stays at mockup state until bridge recovers (no automatic advance on failure)
- Re-requestable: mockup is valid entry state, so brain or Penn can retry

**Service-Level Defense (systemd):**
- flock-mockup-bridge.service has Restart=on-failure
- Host has Wants= + After= (not Requires=) — bridge downtime doesn't kill host
- Order stays at mockup state until bridge recovers
- Next turn retries automatically

---

## Gate 2: Credential Isolation (DALL-E Spend Safety)

**The Problem:** Legacy setup picked up OPENAI_API_KEY from openclaw credential files, leaking gpt-5.5 spend and shared API quota management.

**Invariant:** Bridge service has its own clean EnvironmentFile with explicit OPENAI_API_KEY. No fallback to global credentials.

**Current Impl:**
- flock-mockup-bridge.service reads `/etc/flock-mockup-bridge/env` only (600/root)
- Host reads `/etc/flock-host-v2/env` only (600/root)
- Zero overlap, no shared keys
- Environment isolation prevents credential fallback to legacy files

**Verification:**
```bash
# Bridge should only see its own key
systemctl show flock-mockup-bridge.service -p Environment | grep OPENAI_API_KEY
# Should return exactly one key, not fall back to /root/.openclaw/...

# Host should never see bridge key
systemctl show flock-host-v2.service -p Environment | grep OPENAI_API_KEY
# Should return the host's Anthropic key or nothing (bridge has separate key)
```

---

## Deployment Checklist (Pre-Staging)

- [ ] **Gate 1:** Review onRequestMockup() for empty-urls check. If missing, apply fix above before boot.
- [ ] **Gate 2:** Populate `/etc/flock-mockup-bridge/env` with fresh OPENAI_API_KEY (sk_test_ for staging, sk_live_ for prod).
- [ ] **Gate 2:** Verify bridge env file is 600/root, not readable by other users.
- [ ] **Gate 2:** Confirm bridge service does NOT inherit OPENAI_API_KEY from host env or system.
- [ ] **Bridge startup:** Verify flock-mockup-bridge.service starts and listens on localhost:5051.
- [ ] **Connectivity test:** `curl -X POST http://localhost:5051 -d '{}' -H 'Content-Type: application/json'` should return valid JSON or error, not hang/timeout.

---

## Testing Scenario (Staging)

**Scenario 1: Bridge is healthy**
- M4 mockup request → bridge responds with URLs → order presents + advances to awaiting_decision ✅

**Scenario 2: Bridge returns empty**
- M4 mockup request → bridge fails/returns {} → order escalates, stays at mockup ✅
- Next turn retries automatically (Gate 1 safety)

**Scenario 3: Bridge is down**
- M4 mockup request → fetch timeout → error caught → escalate ✅
- Bridge service restarts automatically (systemd Restart=on-failure)
- Order stays at mockup (Gate 1 safety)

---

## Failure Modes (What NOT to ignore)

| Failure | Symptom | Correct Behavior |
|---------|---------|------------------|
| Bridge down | Mockup request hangs | Timeout caught, escalate, stay at mockup |
| Bridge returns {} | No images, but order advances | Gate 1 blocks this — check + escalate |
| Bridge key leaked | DALLE quota used by legacy system | Gate 2 isolates creds — verify env files |
| Bridge 5051 in use | Address already in use | Kill conflicting process, verify bridge starts |

