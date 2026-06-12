# Flock Host v2 Deployment Checklist

**Current state:** Built, tested offline. Systemd unit staged at `/etc/systemd/system/flock-host-v2.service`. Ready for staging cutover.

**Topology:** Standalone systemd service. Owns Baileys socket directly (§1, §2). Replaces gateway's Flock role entirely.

---

## Pre-Cutover (Staging)

### 1. Prep Secrets
```bash
cp /etc/flock-host-v2/env.template /etc/flock-host-v2/env
# Edit /etc/flock-host-v2/env
#   - Set ANTHROPIC_API_KEY
#   - Set STRIPE_SECRET_KEY (test mode for staging, live for production)
chmod 600 /etc/flock-host-v2/env
```

### 2. Install Dependencies
```bash
cd /root/flock-host-v2
npm install
```

### 3. Validate Boot (First Schema Creation)
```bash
export ANTHROPIC_API_KEY=<key-here>
export SOUL_CONTRACT_PATH=/root/flock-host-v2/flock-soul-contract.md
export DB_PATH=/root/flock-host-v2/flock.db
export WA_AUTH_DIR=/root/flock-host-v2/wa-auth

# Run once offline to create flock.db via IF NOT EXISTS DDL
node src/index.ts
# Ctrl-C after you see "Listening on ..." and confirm flock.db was created

# Verify schema
sqlite3 flock.db ".tables"
sqlite3 flock.db ".schema orders" | head -20
```

### 4. Baileys Pairing (Staging Device)
**⚠️ CRITICAL SEQUENCING: Current wa-auth is paired to legacy gateway. You MUST stop gateway BEFORE v2's first boot.**
**Same WA account, two Baileys holders = connection loop + logout risk. Never concurrent.**

Before killing the gateway:
- Get an iOS device (staging, not production customer phone)
- **STOP gateway first** to release the +1 session (§1, §2 topology — single owner only):
  ```bash
  systemctl stop openclaw-flock.service
  sleep 3
  # Verify no process on 18790
  netstat -tlnp | grep 18790
  ```
- **NOW** start v2 in foreground to capture QR (gateway is stopped, no conflict):
  ```bash
  cd /root/flock-host-v2
  ANTHROPIC_API_KEY=<key> npm start
  # New QR code should appear (old session released by gateway kill)
  # Scan with iOS device (staging, not production)
  # Wait for "WhatsApp ready" log line
  ```
- Test a message: send `test` from the **staging device**, confirm v2 responds
- Ctrl-C and verify flock.db has order entries

### 5. Stripe Test Mode (Staging Run)
Set `STRIPE_SECRET_KEY=sk_test_...` in env file.

Boot v2 in staging:
```bash
systemctl start flock-host-v2.service
systemctl status flock-host-v2.service
journalctl -u flock-host-v2.service -f
```

Send test order from paired device:
- Message: `I need a banner`
- Follow through to payment initiation
- Stripe webhook logs should appear in journal

If webhook fails 9 times, see troubleshooting below.

---

## Cutover (Production)

**⚠️ CRITICAL: Stop gateway BEFORE starting v2. Never concurrent.**

### 1. Final Check (All systems green on staging)
- flock.db exists with schema
- Baileys paired on **staging device** and receives messages (not production)
- Stripe **test mode** (sk_test_) logged successfully
- No active customer sessions on legacy gateway (check /tmp/flock_session_*.json)
- **Mockup bridge** tested independently (see Functional Gaps below)
- **Pricing** confirmed wired (see Functional Gaps below)

### 2. Gateway Already Stopped
(You stopped it in Staging step 4. Verify it's still down:)
```bash
netstat -tlnp | grep 18790
# Should return empty
systemctl status openclaw-flock.service | grep "inactive"
```

### 3. Populate Production Secrets
```bash
# Edit /etc/flock-host-v2/env carefully (no echo, use redact path)
#   - ANTHROPIC_API_KEY (production key — paste without terminal echo)
#   - STRIPE_SECRET_KEY (sk_live_... for production)
chmod 600 /etc/flock-host-v2/env
ls -l /etc/flock-host-v2/env  # Confirm 600, root-owned
```

### 4. Enable & Start v2
```bash
systemctl enable flock-host-v2.service
systemctl start flock-host-v2.service
systemctl status flock-host-v2.service
journalctl -u flock-host-v2.service -f
```

### 5. Validation
- Verify port 18790 listening (or confirm bound port in config)
- Send test message from production WhatsApp number
- Verify order created in flock.db
- Monitor logs for errors

---

## Functional Gaps (Diagnose Before Staging)

The host boots and converses on direct Anthropic today. But won't complete an end-to-end order (intake→mockup→quote→deposit) until these are confirmed:

### 1. Mockup Bridge Service (Self-Healing, Separate Unit)

**Architecture:**
- Separate systemd service: `flock-mockup-bridge.service`
- Runs: `/root/flock-host/mockup_bridge.py` (Python monorepo, not v2)
- Port: localhost:5051 (isolated, independent)
- Isolation: Bridge crash never takes host down (Wants= not Requires=)
- Restart: on-failure (self-healing)

**Startup:**
```bash
sudo systemctl start flock-mockup-bridge.service
sudo systemctl status flock-mockup-bridge.service
netstat -tlnp | grep 5051
# Expected: LISTEN 127.0.0.1:5051
```

**Connectivity test:**
```bash
curl -X POST http://localhost:5051 \
  -d '{"variant":"both","brief":"test"}' \
  -H 'Content-Type: application/json'
# Expected: valid JSON response (success or error), not timeout/hang
```

**Host configuration:**
```bash
# In /etc/flock-host-v2/env, or systemd unit:
MOCKUP_URL=http://localhost:5051
```

**Critical safety gates:** See SAFETY_GATES.md
- **Gate 1:** If bridge returns empty, order must NOT advance (present-before-advance)
- **Gate 2:** Bridge has separate OPENAI_API_KEY env file (no credential bleed)

### 2. Pricing Soul File

**Status:** Check if flock-soul-pricing.md exists and loads at boot.

**Verify:**
```bash
ls -lh /root/flock-host-v2/flock-soul-pricing.md
# Should exist and be readable

journalctl -u flock-host-v2.service | grep pricing
# Should show: "[boot] Pricing tables appended from ..."
```

**In flow:** Brain reads pricing from system prompt (flock-soul-pricing.md appended at boot). If missing, quote stalls at M3.

**Expected:** After M2 specs, brain outputs: "Banner 4x10: $240 (deposit: $80)"

**Critical note on relative paths:** Both `pricingPath` and `dbPath` default to relative (`./*`) and resolve via `WorkingDirectory=/root/flock-host-v2`. This is correct under systemd. **If you launch the binary by hand from another cwd to debug, relative paths resolve there and you silently get a fresh flock.db in the wrong place.** Always use systemd start/restart for real work, or set absolute paths in the env file.

---

## Staging Checklist — Two Phases

### Phase 1: Stub Bridge (Isolate Host State Machine, No API Spend)

**Goal:** Verify M1→M6 flow without bridge/OpenAI/Telegram variability. Isolates state machine.

1. **Stub the bridge responses** in mockup_bridge.py (line ~58):
   ```python
   # Replace the DALL-E call with:
   if os.getenv("BRIDGE_STUB"):
     mockup_result = {"A": "https://sovereigntysolutions.org/mockups/stub.png", "B": "https://sovereigntysolutions.org/mockups/stub-alt.png"}
   else:
     mockup_result = generate_mockup(product_type, client_data, [])
   ```

2. **Set BRIDGE_STUB=1 in /etc/flock-mockup-bridge/env**

3. **Restart bridge:** `sudo systemctl restart flock-mockup-bridge.service`

4. **Run M1→M6 walkthrough from staging device (test JID, sk_test_ Stripe):**
   1. **M1 Greeting** → send message → host greets
   2. **M2 Product** → request banner → host asks dimensions
   3. **M2 Specs** → "4x10 blue" → host collects
   4. **M3 Quote** → host shows price + deposit
   5. **M4 Mockup** → bridge returns stub URLs (no DALL-E)
   6. **M5 Revision** → approve or request changes
   7. **Payment** → Stripe test → webhook succeeds
   8. **M6 Complete** → order.state='complete', order.escalation=null

5. **Verify in DB:**
   ```bash
   sqlite3 /root/flock-host-v2/flock.db \
     "SELECT state, escalation, turn_count FROM orders ORDER BY created_at DESC LIMIT 1;"
   # Expected: state='complete', escalation=NULL, turn_count ~8-12
   ```

**Success criterion:** M1→M6 completes, no escalations, order is clean.

---

### Phase 2: Real Bridge (Test Escalation Gates + API Spend)

**Goal:** Exercise Gate 1a/1b (bridge failure detection), verify escalation-clear on recovery.

1. **Unset BRIDGE_STUB** in `/etc/flock-mockup-bridge/env`

2. **Populate OPENAI_API_KEY with real sk-proj-...** (accept ~$0.10–0.50 spend)

3. **Restart bridge:** `sudo systemctl restart flock-mockup-bridge.service`

4. **Run second M1→M6 walkthrough (different staging JID):**
   - Everything same as Phase 1, but M4 hits real DALL-E now
   - Verify escalation stays null after M6 (no false flags)
   - Check logs: `journalctl -u flock-mockup-bridge.service | grep -i error` (should be empty)

5. **Test bridge-down recovery (Gate 1a):**
   - Start a third M1→M6 walkthrough
   - Pause at M3 (after quote)
   - **Stop bridge:** `sudo systemctl stop flock-mockup-bridge.service`
   - **Client requests mockup** (send any message)
   - Host tries to call bridge → connection refused
   - Verify: `SELECT state, escalation FROM orders WHERE order_id='<order>';` → state='mockup', escalation='manual'
   - Verify Penn got notified: Check Telegram @PA_PennBot for `[escalation:mockup_bridge]` message
   - **Restart bridge:** `sudo systemctl restart flock-mockup-bridge.service`
   - **Client requests mockup again** (send any message)
   - Host calls bridge → succeeds this time
   - Verify: escalation is **cleared to NULL** (Gap 1 fix working)
   - Verify: M4 mockups arrive, order continues to M5

**Success criteria:**
- [ ] Phase 1: M1→M6 end-to-end, state=complete, escalation=null
- [ ] Phase 2: M1→M6 with real DALL-E, costs ~$0.10–0.50
- [ ] Phase 2 (failure): Bridge-down → escalation set → Dan notified → recovery → escalation cleared

---

## Validation After Both Phases

```bash
# All orders should be complete or awaiting input, none stranded
sqlite3 /root/flock-host-v2/flock.db "SELECT state, COUNT(*) FROM orders GROUP BY state;"

# No lingering escalations (all should be null or intentional)
sqlite3 /root/flock-host-v2/flock.db "SELECT escalation, COUNT(*) FROM orders GROUP BY escalation;"
# Expected: one row with escalation=NULL showing all completed orders

# Bridge logs show healthy restarts
journalctl -u flock-mockup-bridge.service | grep "Listening\|error"
# Expected: "Listening on localhost:5051", no error lines
```

---

## Troubleshooting

### flock.db doesn't exist after boot
- **Cause:** Startup failure before DDL ran
- **Check:** `journalctl -u flock-host-v2.service -n 50`
- **Look for:** ANTHROPIC_API_KEY missing, DB_PATH not absolute, permission denied

### Baileys won't pair (QR code loops)
- **Cause:** wa-auth still paired to old session or permissions issue
- **Fix:**
  ```bash
  rm -rf /root/flock-host-v2/wa-auth/*
  systemctl restart flock-host-v2.service
  # New QR code should appear in logs
  ```

### Stripe webhook fails to start
- **Cause:** STRIPE_SECRET_KEY missing or invalid format
- **Fix:** Confirm key in `/etc/flock-host-v2/env` and restart
  ```bash
  systemctl restart flock-host-v2.service
  journalctl -u flock-host-v2.service | grep stripe
  ```

### Orders table empty after messages
- **Cause:** Brain not responding or message handler skipped
- **Check:** `sqlite3 flock.db "SELECT COUNT(*) FROM orders;"`
- **Logs:** Look for `[ERROR]` or `[WARN]` in journal

---

## Rollback

If v2 fails in production:
```bash
systemctl stop flock-host-v2.service
systemctl start openclaw-flock.service
# Legacy conversation_flow_handler.py resumes
# (Note: old wa-auth session may need refresh if gateway lost Baileys lock)
```

---

## Next: Hermes Migration (Optional, Future)

Once v2 is stable on direct Anthropic:

1. Set up Hermes endpoint
2. Run `hermes model` to get model string format
3. Update `routing-policy.json` tiers.cheap and tiers.smart
4. Set `HERMES_API_URL` and `HERMES_API_KEY` in env file
5. Restart: `systemctl restart flock-host-v2.service`

No code changes needed — just env flags.
