# Flock Node Host

The host is Flock's **mouth, ears, ledger, and clock**. It owns the WhatsApp socket, the
order database, and all money. It calls the Hermes "brain" for words, but **the brain only
proposes — the host disposes**: every state change and every charge is validated and
committed by the host, never by the model.

> Prime invariant: nothing the brain says becomes real until the host validates it against
> the state machine and the authorization rules and writes it to the system of record.

## Architecture (hexagonal / ports & adapters)

The invariant-bearing logic depends only on **port interfaces**, so it compiles and unit-tests
with **no external SDKs and no network**. The heavy SDKs sit behind thin adapters that are
wired in at the entrypoint.

```
src/
  domain/        types, state-machine (§6), phase (§4), clock/id ports, integration ports
  store/         store.ts (PORT)            ← sole writer of orders & payments
                 sqlite-store.ts (ADAPTER)  ← better-sqlite3, WAL  [SDK]
                 order-schema.sql           ← system of record (provided, +D-1)
  brain/         actions.ts (parse/strip), hermes-client.ts ([ctx] + HTTP client),
                 action-applier.ts          ← THE CORE: validate + dispose every intent
  payments/      payment-ops.ts (§7 idempotent), providers.ts (PORT + manual),
                 stripe-provider.ts (ADAPTER) [SDK]
  channel/       channel.ts (PORT), cadence.ts (read/typing delays),
                 baileys-adapter.ts (ADAPTER) [SDK]
  ops/           escalation.ts (Telegram via fetch), scheduler.ts (§8),
                 reconcile.ts (§9), heartbeat.ts (§10)
  integrations/  http-integrations.ts       ← mockup / supplier / delivery webhooks (§12)
  model-router.ts, routing-policy.json      ← provided, UNMODIFIED
  host.ts        ← §4 turn lifecycle + clearance/supplier-gated production
  config.ts, index.ts
test/core.test.ts ← runs under tsx, no deps
```

**Adapters that import an SDK** (excluded from the offline typecheck): `sqlite-store.ts`,
`baileys-adapter.ts`, `stripe-provider.ts`. Everything else is verifiable offline.

## What the host guarantees

- **State machine (§6).** `domain/state-machine.ts` encodes the transition table verbatim;
  `store.transition()` re-checks legality and writes the `state_change` event atomically.
  Illegal proposed intents are rejected and logged, never applied.
- **Idempotent money (§7).** `payment-ops.ts` builds `idempotency_key = {order_id}:{kind}:{disc}`
  (`disc` = `1` for deposit/balance, block index for digital, `supplier_id` for supplier
  deposit) and does **insert-before-charge**: a `pending` row is committed before the
  provider is called, so a crash-and-retry hits the UNIQUE constraint and cannot double-charge.
- **Brain can't lie about reality.** The host only tells the client a payment cleared after it
  has committed the success (`onPaymentConfirmed`). Deposit/digital state advances are
  *request*-driven (pipeline position); clearance is read separately from the ledger.
- **Crash safety (§9).** On boot, `reconcile()` replays inbound messages that were never
  answered (linking the reply to the *original* inbound event so it can't loop) and settles
  pending payments that carry an external ref.

## Run

```bash
npm install                 # pulls baileys, better-sqlite3, stripe, @types/*
cp .env.example .env         # set HERMES_API_URL etc. (see config.ts)
npm start                    # tsx src/index.ts  (boots, reconciles, then serves)
```

Required env: `HERMES_API_URL`. Common: `DB_PATH`, `WA_AUTH_DIR`, `STRIPE_SECRET_KEY`,
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `MOCKUP_URL`, `SUPPLIER_QUEUE_URL`, `DELIVERY_URL`,
`DEFAULT_PAYMENT_METHOD` (`stripe` default; `zelle`/`oxxo`/`cash` use the manual provider).

The process runs under `tsx` (systemd: `ExecStart=/usr/bin/npx tsx src/index.ts`). This is
deliberate — see D-3.

## Verify

```bash
npm test            # 10/10 — state machine, parser, SOUL worked example, idempotency,
                    # illegal-intent rejection, host turn lifecycle. No deps, no network.
npm run typecheck:core   # 0 errors — the invariant core, offline (uses the dev shim)
npm run typecheck        # full project; needs `npm install` first
```

## Deliberate decisions (where the spec was underspecified)

- **D-1 — `events.inbound_event_id`.** §4/§9 require linking each `msg_sent` to the inbound it
  answered, but the provided schema had no column for it. Added the column + an index, and made
  all DDL `IF NOT EXISTS`. This is the only change to the provided SQL.
- **D-2 — Ports/adapters.** Chosen so the invariant core is verifiable offline. No behavioural
  effect; purely structural.
- **D-3 — Run under `tsx` / Bundler resolution.** The provided `model-router.ts` does a bare
  `import policy from "./routing-policy.json"`. Under `module: NodeNext` modern TS requires an
  import attribute, and native Node ESM rejects attribute-less JSON imports at runtime — both
  would force editing the provided file. Running under `tsx` (esbuild) inlines the JSON, and
  `moduleResolution: "Bundler"` typechecks it, so the file stays **verbatim**.
- **D-4 — No SDK for Telegram or IDs.** Penn notifications use the Telegram Bot API over
  `fetch`; IDs use built-in `crypto.randomUUID()`. Fewer native deps to install.
- **D-5 — Phase derivation.** `first_contact`, `revision_loop`, and `dispute` are derived
  deterministically from host state. `negotiation` and `quote_objection` need a signal the host
  doesn't own yet, so they stay reachable through the router's friction keywords rather than
  being guessed.
- **D-6 — Supplier deposit = 50% of the selected quote.** The spec defines the `supplier_deposit`
  ledger row but not its amount; 50% mirrors the client deposit. Configurable in `host.ts`.
- **D-7 — Forfeiture timing.** There is one terminal `forfeited` state. So the 7-day / 50%
  rule is surfaced as **terms stated in the stage-1 follow-up message**, and the actual
  transition to `forfeited` (100%) fires at 30 days of silence on a paid, forfeitable order.
- **D-8 — Production gating.** `awaiting_decision → deposit_pending|digital_pending` is
  *request*-driven (the order has reached that stage; the deposit may still be clearing — §8's
  forfeit rules read clearance from the ledger, which this matches). `balance_pending →
  in_production` is gated on the balance **clearing** *and* a supplier being selected, since
  production shouldn't start on unpaid/unsourced work.
- **D-9 — Silent turns + path traversal.** A `[SILENT]` turn writes a linked `msg_sent` marker
  (no socket send) so reconciliation doesn't treat it as unanswered forever. `approve_for_print`
  and `digital_complete` auto-traverse through `revision` when needed, because the state machine
  has no direct `deposit_pending → balance_pending` or `digital_pending → closed` edge.

## Not in this repo (built elsewhere, §12)

Mockup generation, the Supplier Agent, and final-file delivery are external; the host calls
them through `integrations/http-integrations.ts` (configurable webhook URLs). If an endpoint is
unconfigured the adapter throws — a stalled order beats a fake "done".
