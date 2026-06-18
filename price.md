# Flock System Reference — Pricing & DB Audit

*Last updated: 2026-06-15. Read-only reference. Do not edit pricing numbers here — source of truth is `flock-soul-pricing.md` (brain) and `src/pricing/pricing.ts` (host).*

---

## flock.db Schema Audit (2026-06-15)

### Tables

| Table | Primary Key | JID scope | Key columns |
|---|---|---|---|
| `orders` | `order_id` TEXT (ULID) | **Direct** — `whatsapp_jid` + index | `state`, `track`, `job_spec` (JSON), `escalation`, `turn_count`, `hermes_session_id`, `client_name`, `business_name`, `selected_mockup`, `dormant_since`, `follow_up_stage`, `failed_mockup_pairs`, `digital_rounds_used`, `assigned_supplier_id`, `last_tier`, `force_tier` |
| `events` | `event_id` TEXT (UUID) | **Indirect** — via `order_id → orders.whatsapp_jid` | `actor` (`flock`/`client`/`penn`/`system`), `type`, `payload` (JSON), `inbound_event_id` (reply-chain link) |
| `assets` | `asset_id` UUID | **Direct** — `jid` column + index | `bytes_hash` FK, `asset_type`, `role`, `version` (per jid+type, monotonic), `is_current` (0/1), `resolution_hint`, `width_px`, `height_px`, `is_vector` |
| `asset_bytes` | `bytes_hash` SHA-256 hex | **None** — content-addressed dedup store | `content` BLOB, `bytes_size`, `created_at` |
| `quotes` | `quote_id` TEXT | **Indirect** — via `order_id` | `supplier_id`, `amount_cents`, `currency`, `status`, `raw` (audit blob) |
| `payments` | `payment_id` TEXT | **Indirect** — via `order_id` | `kind`, `direction`, `amount_cents`, `currency`, `method`, `status`, `external_ref`, `idempotency_key UNIQUE` |

### Asset store: JID-scoping and cross-order survival

`assets` is keyed by `jid`, **not** `order_id`. There is no FK from `assets` to `orders`.

- `UNIQUE INDEX idx_assets_current ON assets(jid, asset_type) WHERE is_current = 1` — exactly one live asset per JID per type at any time.
- `UNIQUE INDEX idx_assets_version ON assets(jid, asset_type, version) WHERE role = 'fidelity'` — monotonic versioning per JID, not per order.
- A returning JID's logo is available to any new order via `WHERE jid = ? AND asset_type = 'logo' AND is_current = 1`. No order context required.
- `asset_bytes` deduplicates by content: same bytes uploaded by two different JIDs = one BLOB row, two `assets` binding rows.
- **Current state (2026-06-15):** 0 rows in both tables — no production uploads yet.

### Conversation history: what is persisted

Full transcript is event-sourced in the `events` table. No separate transcript table exists.

| `type` | `actor` | Payload contents |
|---|---|---|
| `msg_recv` | `client` | `{text, wa_media_ref}` — full WhatsApp message + media URL, encryption keys, JPEG thumbnail |
| `msg_sent` | `flock` | `{text}` or `{text, follow_up_stage}` for dormancy messages |
| `brain_attempt` | `system` | `{message, timestamp}` — text passed to LLM (image bytes not stored; replaced with description string) |
| `brain_outcome` | `system` | `{status, latencyMs}` — metadata only; LLM reply text is NOT stored here |
| `router` | `system` | `{tier, model, reason}` — which Claude model was selected |
| `state_change` | `flock`/`system` | `{from, to, reason}` |
| `escalation` | `system`/`penn` | `{reason, delivered}` |
| `payment` | `penn` | payment details |

`orders.turn_count` = counter only, not transcript. `orders.hermes_session_id` = routing handle to the Claude Messages API session; not a persistence store. Conversation context is reconstructed from `events` (`msg_recv` + `msg_sent`) on each turn.

**Gap:** `brain_outcome` does not record the LLM reply text — that lives only in the subsequent `msg_sent` event.

### Client identity: is there a reusable record?

**No.** No `clients` table exists. Identity = JID + most recent non-terminal order.

- `client_name` and `business_name` are columns on `orders` — re-collected each intake.
- No address, email, or secondary contact field anywhere in the DB.
- No `parent_order_id` or returning-client flag linking orders for the same JID.
- Only cross-order persistence for a returning JID: (a) the `assets` table and (b) querying `orders WHERE whatsapp_jid = ?` manually — nothing surfaces this automatically to the brain today.

---

## Product Catalog Cross-Reference (2026-06-15)

Sources: `src/pricing/pricing.ts` (host pricing engine) · `src/integrations/sharp-compositor.ts` REGISTRY (mockup templates).

### Auto-priced products (unit-tiered)

| `product_type` | Pricing key | Auto-priced? | Escalates to Dan? | Mockup template? | Flags |
|---|---|---|---|---|---|
| `tshirt` | UNIT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `hat` | UNIT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `tote` | UNIT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `mug` | UNIT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `dtf_transfer` | UNIT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `sky_dancer` | UNIT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `flag` | UNIT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |

### Auto-priced products (sqft-tiered)

| `product_type` | Pricing key | Auto-priced? | Escalates to Dan? | Mockup template? | Flags |
|---|---|---|---|---|---|
| `banner_standard` | SQFT_TIERS | ✅ yes | ❌ no | ✅ dedicated A+B | none |
| `banner_uv` | SQFT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `vinyl_mesh_materials` | SQFT_TIERS | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |

### Auto-priced products (flat-print run)

External product_type `business_cards` routes internally to `business_cards_design` or `business_cards_print` via `print_variant` input.

| `product_type` | Pricing key | Auto-priced? | Escalates to Dan? | Mockup template? | Flags |
|---|---|---|---|---|---|
| `business_cards` | FLAT_PRINT (design/print_only) | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `flyer` | FLAT_PRINT | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `tabloid` | FLAT_PRINT | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |
| `brochure` | FLAT_PRINT | ✅ yes | ❌ no | ⚠️ falls to `generic` | template gap |

### Dan-approval products (no auto-quote)

| `product_type` | DAN_APPROVAL display name | Auto-priced? | Escalates to Dan? | Mockup template? | Flags |
|---|---|---|---|---|---|
| `vehicle_wrap_partial` | Partial Vehicle Wrap | ❌ no | ✅ yes | ❌ none | expected — never reaches mockup |
| `vehicle_wrap_full` | Full Vehicle Wrap | ❌ no | ✅ yes | ❌ none | expected — never reaches mockup |
| `business_signage_indoor` | Indoor Illuminated Sign | ❌ no | ✅ yes | ❌ none | expected |
| `business_signage_exterior_flat` | Exterior Flat Sign | ❌ no | ✅ yes | ❌ none | expected |
| `business_signage_exterior_lit` | Exterior Illuminated Box Sign | ❌ no | ✅ yes | ❌ none | expected |
| `channel_letters` | Channel Letters | ❌ no | ✅ yes | ❌ none | expected |
| `monument_pylon` | Monument / Pylon Sign | ❌ no | ✅ yes | ❌ none | expected |
| `cut_vinyl` | Cut Vinyl | ❌ no | ✅ yes | ❌ none | expected |
| `sticker` | Stickers (size-dependent) | ❌ no | ✅ yes | ❌ none | expected |
| `social_media_assets` | Social Media Package | ❌ no | ✅ yes | ❌ none | expected |
| `packaging` | Custom Packaging | ❌ no | ✅ yes | ❌ none | expected |
| `specialty_fabrication` | Specialty Fabrication | ❌ no | ✅ yes | ❌ none | expected |

### Special / non-table products

| `product_type` | Treatment | Auto-priced? | Escalates to Dan? | Mockup template? | Flags |
|---|---|---|---|---|---|
| `digital` | Flat $5/block via payment-ops (`kind='digital'`, `DIGITAL_BLOCK_CENTS`) | ❌ not table-priced | ❌ no | ⚠️ falls to `generic` | intentional — payment-ops owns this, not pricing table |
| `generic` | Compositor fallback only — not a real intake product_type | ❌ no | ❌ no | ✅ A+B (is the fallback) | not a product; exists as template fallback only |

### Summary of flags

**Template gap (priced but no dedicated template) — 12 products:**
`tshirt`, `hat`, `tote`, `mug`, `dtf_transfer`, `sky_dancer`, `flag`, `banner_uv`, `vinyl_mesh_materials`, `business_cards`, `flyer`, `tabloid`, `brochure` — all fall through to the `generic` banner layout (3000×1200, landscape) when a mockup is requested. This layout is meaningless for apparel, mugs, business cards, etc.

**Dan-gated with no template — 12 products:**
All 12 DAN_APPROVAL products. This is expected: they escalate before reaching the mockup step and Dan provides the custom quote offline.

**REGISTRY contents (sharp-compositor.ts):**
Only two entries: `banner_standard` (A+B with proper banner layout) and `generic` (A+B as fallback). Every other product_type gets the generic banner layout.

---

## Hardcoded Financial Constants (2026-06-15)

Numbers that live in code but are absent from `flock-soul-pricing.md`. No contradictions found — these extend, not conflict with, the pricing doc.

| Constant | Value | File | Notes |
|---|---|---|---|
| `DIGITAL_BLOCK_CENTS` | 500 ($5) | `src/payments/payment-ops.ts:30` | Matches soul pricing "$5 flat on any product" |
| `REVISION_BLOCK_CENTS` | 500 ($5) | `src/payments/payment-ops.ts:31` | Matches soul pricing "$5 per additional round" |
| Deposit/balance split | `Math.round(price * 0.5)` — 50% each | `src/payments/payment-ops.ts:66` | Same formula for both deposit and balance payments |
| `MIN_CENTS` | 15000 ($150) | `src/pricing/pricing.ts:103` | Applied after urgency multiplier on all auto-priced products |
| `forfeitMs` | `30 * 24 * H` (30 days) | `src/ops/scheduler.ts:34` | Forfeiture fires after 30 days of silence on a paid order |

### Supplier deposit (undocumented in flock-soul-pricing.md)

Source: `README.md` D-6 + `src/payments/payment-ops.ts`.

Supplier deposit = **50% of the selected supplier quote** (not 50% of the client price). The percentage mirrors the client deposit split. Configurable in `host.ts` but not exposed in the pricing doc.

### Forfeit timeline (undocumented in flock-soul-pricing.md)

Source: `README.md` D-7 + `src/ops/scheduler.ts`.

- **Stage-1 follow-up** (36–48h of silence on a paid, forfeitable order): brain is prompted to mention gently that "the deposit holds the slot for 7 days and is fully forfeit if we don't hear back within 30."
- **Forfeiture** (`→ forfeited`): fires after `forfeitMs = 30 days` of silence with deposit held.
- Forfeitable states: `deposit_pending`, `revision`, `balance_pending`.
- Non-forfeitable states (deposit not yet held): `intake`, `mockup`, `awaiting_decision`.

### gpt-image-1 API spend (Phase 2 mockups)

Source: `DEPLOY.md` staging checklist + `src/integrations/sharp-compositor.ts:129`.

Estimated ~$0.011/image at low quality (logged per call via `[spend:gpt-image-1]`). Phase 2 staging run expected ~$0.10–0.50 total. Phase 1 (solid bg) has zero API spend.

---

## Beacon — Facebook Access Options (2026-06-15)

### What Beacon currently does

`beacon_group_scout.py` (ran once 2026-05-16) uses the **Brave Search API** to find
publicly indexed `facebook.com/groups` URLs and sends the list to Dan via Telegram so
a human can join manually. It does NOT read any group content or competitor posts.
The `beacon_recon` capability is template-only — not yet built.

### Three paths to Facebook access

#### 1. Facebook Graph API — recommended, ToS-compliant

Reads public business Page posts (text, photos, about). No groups, no private profiles.

**What you need:**
- Meta developer app (free, ~15 min to create at developers.facebook.com)
- Long-lived User Access Token from Dan's Facebook account (60-day expiry, refreshable)
- `pages_read_engagement` permission (basic page reading, usually fast to approve)

**What Beacon can read:** any public competitor Page feed — pricing flyers posted as
text or images, promotions, product announcements.

**Implementation pattern** (mirrors existing Brave key setup):
1. Dan creates Meta developer app
2. Dan approves app with his account → long-lived User Access Token generated
3. Store token at `/root/.openclaw/credentials/facebook-graph-token.txt`
4. Beacon polls `graph.facebook.com/{page_id}/posts` per competitor on a schedule
5. Filter posts with `$`, price keywords, product names → Telegram digest to Dan
6. Image posts (pricing flyers) need OCR or vision model to extract numbers

#### 2. Playwright with logged-in session — grey area, ToS risk

Headless Chromium with Dan's Facebook credentials. Sees everything a logged-in user
sees: pages, groups, Marketplace. Risk: Meta detects automated sessions and can ban
the account — puts Flock Media's Facebook presence at risk. Not recommended.

#### 3. Apify / Bright Data scraper — third-party, explicit ToS violation

Pre-authenticated scraping services. Technically reliable but violates Meta ToS and
gets blocked periodically. Not recommended.

### Activation path for Beacon competitor recon

Graph API is the correct next step. Remaining gaps before Beacon can run price recon:

- [ ] Dan creates Meta developer app + approves with his account
- [ ] Long-lived token stored at `/root/.openclaw/credentials/facebook-graph-token.txt`
- [ ] Competitor Page IDs compiled (one per shop in target list)
- [ ] `beacon_recon` module written (poll page feed → keyword filter → Telegram digest)
- [ ] Vision/OCR step added for image-based pricing flyers
- [ ] Polling interval and escalation rules defined (see Beacon activation checklist)
