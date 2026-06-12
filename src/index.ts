// index.ts
// systemd entrypoint. Loads the SOUL contract from disk, wires adapters, reconciles,
// then starts the inbound handler + scheduler + heartbeat.

import { readFileSync, existsSync } from "node:fs";
import pino from "pino";
import { loadConfig } from "./config.js";
import { systemClock, uuidGen } from "./domain/ports.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { AnthropicClient, HttpHermesClient } from "./brain/hermes-client.js";
import { ActionApplier } from "./brain/action-applier.js";
import { PaymentOps } from "./payments/payment-ops.js";
import { StripeProvider } from "./payments/stripe-provider.js";
import { ManualProvider, usdOnlyFx, PaymentProvider } from "./payments/providers.js";
import { TelegramNotifier, ConsoleNotifier } from "./ops/escalation.js";
import { BaileysChannel } from "./channel/baileys-adapter.js";
import { AssetStore } from "./store/asset-store.js";
import { LengthScaledCadence, sleep } from "./channel/cadence.js";
import { HttpSupplierQueue, HttpDelivery } from "./integrations/http-integrations.js";
import { SharpCompositor, FilesystemMockupSink } from "./integrations/sharp-compositor.js";
import { Host } from "./host.js";
import { reconcile } from "./ops/reconcile.js";
import { Scheduler } from "./ops/scheduler.js";
import { Heartbeat } from "./ops/heartbeat.js";
import { startWebhookServer } from "./ops/stripe-webhook.js";

async function main(): Promise<void> {
  // Boot observability — structured logging via pino to systemd/journalctl.
  const logger = pino();
  logger.info({ msg: "flock-v2 boot", pid: process.pid }, "boot");

  const cfg = loadConfig();
  const clock = systemClock;
  const idGen = uuidGen;

  // Load SOUL contract — the brain's operating instructions.
  let systemPrompt = "";
  if (existsSync(cfg.soulContractPath)) {
    systemPrompt = readFileSync(cfg.soulContractPath, "utf8");
    console.log(`[boot] SOUL contract loaded from ${cfg.soulContractPath}`);
  } else {
    console.warn(`[boot] SOUL contract not found at ${cfg.soulContractPath} — brain has no persona`);
  }

  // Append pricing tables — same source of truth as the host's pricing engine.
  // Brain quotes from this; host charges from pricing.ts. They must stay in sync.
  if (existsSync(cfg.pricingPath)) {
    systemPrompt += "\n\n" + readFileSync(cfg.pricingPath, "utf8");
    console.log(`[boot] Pricing tables appended from ${cfg.pricingPath}`);
  } else {
    console.warn(`[boot] Pricing file not found at ${cfg.pricingPath} — brain will not know prices`);
  }

  const store = new SqliteStore(cfg.dbPath, clock, idGen);

  // Brain: Anthropic direct by default; custom HTTP endpoint if HERMES_API_URL is set.
  const brain = cfg.hermes
    ? new HttpHermesClient(cfg.hermes)
    : new AnthropicClient(cfg.anthropicApiKey, cfg.maxTokens);

  const provider: PaymentProvider = process.env.STRIPE_SECRET_KEY
    ? new StripeProvider(process.env.STRIPE_SECRET_KEY, cfg.stripe.successUrl, cfg.stripe.cancelUrl)
    : new ManualProvider(cfg.defaultPaymentMethod);

  const payments = new PaymentOps(store, provider, usdOnlyFx, clock);
  const notifier = cfg.telegram
    ? new TelegramNotifier(cfg.telegram.botToken, cfg.telegram.chatId)
    : new ConsoleNotifier();
  const cadence = new LengthScaledCadence();
  const channel = new BaileysChannel(cfg.waAuthDir);

  const assetStore = new AssetStore(store.db, clock, idGen);

  const applier = new ActionApplier({
    store,
    payments,
    mockups: new SharpCompositor({
      assets: assetStore,
      sink: new FilesystemMockupSink(
        process.env.MOCKUP_DIR ?? '/var/www/flock-mockups',
        process.env.MOCKUP_PUBLIC_URL ?? 'https://flockprints.com/mockups',
      ),
    }),
    supplierQueue: new HttpSupplierQueue(cfg.integrations.supplierUrl),
    delivery: new HttpDelivery(cfg.integrations.deliveryUrl),
    notifier,
    clock,
    defaultMethod: cfg.defaultPaymentMethod,
    assetStore,
  });

  const host = new Host({
    store, brain, applier, payments, channel, cadence,
    notifier, clock, idGen, sleep, systemPrompt, assetStore,
    logger,  // Pass the pino logger so Obs can use it for structured logging
  });

  // §9 — settle the past BEFORE taking new messages.
  const rec = await reconcile({ store, host, provider });
  console.log(`[boot] reconciled: ${JSON.stringify(rec)}`);

  host.attach();
  await channel.start();

  // §8 scheduler (dormancy-based follow-ups: ~hourly).
  const scheduler = new Scheduler({ store, brain, applier, channel, cadence, notifier, clock, sleep });
  setInterval(() => void scheduler.sweep(), cfg.intervals.schedulerMs);

  // Mockup watchdog (stuck-at-mockup detection: ~30s, decoupled from dormancy sweep).
  // Anchors to state-entry time, fires independently to catch hangs/bridges-down without waiting for hourly sweep.
  setInterval(() => void scheduler.watchMockupState(), 30_000);

  // §10 heartbeat.
  const heartbeat = new Heartbeat({
    notifier, clock,
    stats: () => ({
      activeOrders: store.findQuietOrders(clock.nowIso()).length,
      cheapTurns: 0,
      smartTurns: 0,
    }),
  });
  setInterval(() => void heartbeat.beat(), cfg.intervals.heartbeatMs);

  const shutdown = async () => { await channel.stop(); store.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // §15 — admin HTTP server (localhost-only).
  // /manual/confirm and /manual/pending always active (Zelle/OXXO/cash confirmation path).
  // /stripe/webhook additionally active when STRIPE_WEBHOOK_SECRET + STRIPE_SECRET_KEY are set.
  startWebhookServer({
    port: cfg.stripe.webhookPort,
    webhookSecret: cfg.stripe.webhookSecret,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    host,
    store,
  });

  console.log("[boot] Flock host up.");
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
