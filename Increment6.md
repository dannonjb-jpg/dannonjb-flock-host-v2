# Increment 6 — Client Profile

**Branch:** `client-profile` (off `element-addressable-spec`)
**Date:** 2026-06-18
**Payments path:** untouched — zero diff in `src/payments/`
**Not merged.** Tests required; do not merge.

Tests at close: **10/10** client-profile, **21/21** core — zero regressions.

---

## Goal

Persistent client record keyed on `whatsapp_jid`. Every collect action that
surfaces a name, business, or address upserts the record. Returning clients are
recognised before the brain speaks. Brain can request recall of any past job spec
via `retrieve_past_job`.

---

## Part A — Client schema

### `src/store/order-schema.sql` — `clients` table (after `events`)

```sql
CREATE TABLE IF NOT EXISTS clients (
  client_id        TEXT PRIMARY KEY,      -- host-generated UUID
  whatsapp_jid     TEXT UNIQUE NOT NULL,  -- the stable key
  name             TEXT,
  business         TEXT,
  delivery_address TEXT,
  created_at       TEXT NOT NULL,         -- ISO8601
  updated_at       TEXT NOT NULL          -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_clients_jid ON clients(whatsapp_jid);
```

Uses `CREATE TABLE IF NOT EXISTS` — handles both fresh DBs and existing ones
without a migration step. The `UNIQUE` constraint on `whatsapp_jid` enforces
exactly one profile per client.

---

## Part B — Domain type

### `src/domain/types.ts` — `Client` interface

Added after `Order` (`:106–114`):

```typescript
export interface Client {
  client_id: string;
  whatsapp_jid: string;
  name?: string;
  business?: string;
  delivery_address?: string;
  created_at: string;
  updated_at: string;
}
```

Also added `recalled_job?` to `JobSpec` (`:165–171`):

```typescript
recalled_job?: {
  order_id: string;
  job_spec: JobSpec | null;
  selected_mockup: "A" | "B" | null;
  price_cents: number | null;
  mockup_urls: { A?: string; B?: string } | null;
};
```

`recalled_job` is how `retrieve_past_job` surfaces data to the brain — stored
in the current order's `job_spec` so the brain reads it on the next turn.

---

## Part C — Store interface + implementation

### `src/store/store.ts` — three methods added to `Store` interface

```typescript
addOrUpdateClient(jid, name?, business?, delivery_address?): Client;
getClientByJid(jid: string): Client | null;
getClientOrders(jid: string): Order[];
```

- `addOrUpdateClient`: upsert semantics — `undefined` means "do not touch this
  field on update"; `null` means "clear it". Name + business are safe to pass on
  every collect; address is only passed when the field appears in the action.
- `getClientOrders`: returns all orders (any state), newest first.

`Client` imported from `../domain/types.js`.

### `src/store/sqlite-store.ts` — implementation

`addOrUpdateClient` (`:148–167`):
- Checks for an existing row via `getClientByJid(jid)`.
- **Create path**: `INSERT` with all provided fields.
- **Update path**: builds a `SET` clause from only the provided (non-`undefined`) fields.
  `updated_at` always bumped.

`getClientByJid` (`:169–171`):
- `SELECT * FROM clients WHERE whatsapp_jid = ?` — returns the row as `Client | null`.

`getClientOrders` (`:173–175`):
- `SELECT * FROM orders WHERE whatsapp_jid = ? ORDER BY created_at DESC` — all
  states included; caller filters if needed.

No `ALTER TABLE` migration needed — the clients table is entirely new and the
schema DDL uses `IF NOT EXISTS`.

---

## Part D — Action applier integration

### `src/brain/action-applier.ts`

#### 1. `onCollect` upsert (`:293–302`)

After calling `store.patchOrder`, checks which of `client_name`, `business_name`,
`delivery_address` were present in the collect `fields` map:

```typescript
const clientName     = "client_name"      in fields && typeof fields.client_name      === "string" ? fields.client_name      : undefined;
const clientBusiness = "business_name"    in fields && typeof fields.business_name    === "string" ? fields.business_name    : undefined;
const clientAddress  = "delivery_address" in fields && typeof fields.delivery_address === "string" ? fields.delivery_address : undefined;
if (clientName !== undefined || clientBusiness !== undefined || clientAddress !== undefined) {
  this.d.store.addOrUpdateClient(order.whatsapp_jid, clientName, clientBusiness, clientAddress);
}
```

Address only propagates to the client record when `delivery_address` is explicitly
in the collect payload — not inferred from the order. Name and business update
whenever they appear.

#### 2. `recognizeReturningClient(jid)` public method (`:246–248`)

```typescript
recognizeReturningClient(jid: string): Client | null {
  return this.d.store.getClientByJid(jid);
}
```

Called by the host in `handleInbound` when the order's `turn_count === 0` (brand
new order). If the JID is known, the host passes the client record as context to
the brain ("Welcome back, ${name}…"). The method is public and thin so the host
owns the greeting copy.

#### 3. `retrieve_past_job` action type — `src/brain/actions.ts`

New union member and coerce case:
```typescript
| { type: "retrieve_past_job"; order_id: string }
```

Validated in `coerceAction`: requires `order_id: string`.

#### 4. `onRetrievePastJob` handler (`:316–330`)

```typescript
private onRetrievePastJob(order: Order, targetOrderId: string): string | null {
  const target = this.d.store.getOrder(targetOrderId);
  if (!target) return `order ${targetOrderId} not found`;
  if (target.whatsapp_jid !== order.whatsapp_jid) return "order belongs to a different client";
  const targetSpec = readSpec(target);
  const spec = readSpec(order);
  spec.recalled_job = {
    order_id: targetOrderId,
    job_spec: targetSpec,
    selected_mockup: target.selected_mockup,
    price_cents: typeof targetSpec.price_cents === "number" ? targetSpec.price_cents : null,
    mockup_urls: targetSpec.mockup_urls ?? null,
  };
  this.d.store.patchOrder(order.order_id, { job_spec: JSON.stringify(spec) });
  return null;
}
```

Two guards:
- `order not found` — unknown `order_id`.
- `order belongs to a different client` — JID mismatch; prevents cross-client
  spec leakage.

Recalled data is stored in the current order's `job_spec.recalled_job` and is
visible to the brain on the next turn without any extra action.

---

## Part E — Test results

```
test/client-profile.test.ts   10/10 passed
test/core.test.ts             21/21 passed
```

### Test inventory (`test/client-profile.test.ts`)

| # | Test name |
|---|---|
| 1 | `addOrUpdateClient: new client created with all fields` |
| 2 | `addOrUpdateClient: existing client updated (name, business, address)` |
| 3 | `addOrUpdateClient: partial update — only passed fields change` |
| 4 | `getClientByJid: returns client if exists, null if not` |
| 5 | `getClientOrders: returns all orders for JID across all states` |
| 6 | `onCollect: calls addOrUpdateClient with collected client_name and business_name` |
| 7 | `onCollect: address only updates client profile when delivery_address is explicitly collected` |
| 8 | `recognizeReturningClient: returns client record for known JID, null for unknown` |
| 9 | `retrievePastJob: surfaces recalled order spec and validates JID ownership` |
| 10 | `retrievePastJob: rejected when target order belongs to different client` |

Tests 1–5 are store-method unit tests (pure in-memory). Tests 6–7 exercise the
`onCollect` integration path end-to-end through `ActionApplier`. Test 8 exercises
`recognizeReturningClient` directly. Tests 9–10 cover both the happy path and the
JID-guard on `retrieve_past_job`.

---

## Part F — File:line citations

### 1. Client schema (`src/store/order-schema.sql`)

`clients` table + index: appended after events DDL (`:159–176`).

### 2. Client type (`src/domain/types.ts`)

| Item | Location |
|---|---|
| `Client` interface | `:106–114` |
| `JobSpec.recalled_job?` | `:165–171` |

### 3. Store interface (`src/store/store.ts`)

```
addOrUpdateClient  — line ~76
getClientByJid     — line ~78
getClientOrders    — line ~80
```

`Client` imported from `../domain/types.js` at `:22`.

### 4. Store implementation (`src/store/sqlite-store.ts`)

```
addOrUpdateClient  — :148–167
getClientByJid     — :169–171
getClientOrders    — :173–175
```

`Client` imported at `:26`.

### 5. `onCollect` integration (`src/brain/action-applier.ts`)

Client upsert logic: `:293–302` (immediately after `store.patchOrder`).

### 6. Returning-client recognition

`recognizeReturningClient(jid)` public method: `:246–248`.
The host calls this when `order.turn_count === 0` and uses the returned `Client`
to build the welcome-back context prefix for the brain.

### 7. `retrieve_past_job` implementation

- Action type union + coerce: `src/brain/actions.ts` `:29`, `:103–104`
- `applyOne` case: `src/brain/action-applier.ts` `:232`
- `onRetrievePastJob` handler: `:316–330`

### 8. Test changes

| File | Change |
|---|---|
| `test/client-profile.test.ts` | NEW — 10 tests, 260 lines |
| `test/core.test.ts` | `FakeStore.clients` map + 3 client methods + `succeededRevisionBlocks` |

### 9. Diff summary

| File | +lines | −lines | Note |
|---|---|---|---|
| `src/domain/types.ts` | +22 | 0 | `Client` interface + `recalled_job?` in `JobSpec` |
| `src/store/order-schema.sql` | +18 | 0 | `clients` table + index |
| `src/store/store.ts` | +8 | 0 | 3 client methods + `Client` import |
| `src/store/sqlite-store.ts` | +32 | 0 | Implementation + `Client` import |
| `src/brain/actions.ts` | +3 | 0 | `retrieve_past_job` action + coerce |
| `src/brain/action-applier.ts` | +35 | 0 | onCollect upsert + recognizeReturningClient + onRetrievePastJob |
| `test/core.test.ts` | +22 | 0 | FakeStore client stubs + succeededRevisionBlocks |
| `test/client-profile.test.ts` | +260 | 0 | NEW — full test suite |
| **Total** | **~400** | **0** | |

`src/payments/` — **zero diff**. Constraint honoured.

### 10. MVP notes / TODO flags

- `recognizeReturningClient` is wired on the `ActionApplier`; host.ts integration
  (injecting the client record into the `[ctx]` header) is the next wiring step,
  deferred to keep this increment focused.
- `getClientOrders` returns all states including terminal — callers should filter
  to non-terminal if showing "active orders" to the brain.
- `recalled_job.job_spec` is a copy of the target's full `JobSpec` at recall time;
  if the brain asks to build on a past design it should emit `collect` + `request_mockup`
  with the recalled brief, not replay the old actions.
- No prune/GC policy on the `clients` table — low-volume; one row per real client.
