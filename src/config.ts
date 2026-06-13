// config.ts
// Environment-driven config. Secrets and endpoints live in the environment / systemd
// unit, never in code.

import { PaymentMethod } from "./domain/types.js";

export interface Config {
  dbPath: string;
  waAuthDir: string;
  anthropicApiKey: string;       // ANTHROPIC_API_KEY  (direct Anthropic client)
  soulContractPath: string;      // SOUL_CONTRACT_PATH (defaults to ./flock-soul-contract.md)
  pricingPath: string;           // PRICING_PATH       (defaults to ./flock-soul-pricing.md)
  maxTokens: number;             // MAX_TOKENS         (brain reply ceiling, default 2048)
  hermes?: { baseUrl: string; apiKey?: string; modelHeader?: string }; // custom endpoint fallback
  defaultPaymentMethod: PaymentMethod;
  stripe: { successUrl: string; cancelUrl: string; webhookSecret?: string; webhookPort: number };
  telegram?: { botToken: string; chatId: string };
  integrations: { mockupUrl?: string; supplierUrl?: string; deliveryUrl?: string };
  intervals: { schedulerMs: number; heartbeatMs: number };
  operatorJids: string[];        // OPERATOR_JIDS — never create orders or follow up for these
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const hermesUrl = process.env.HERMES_API_URL;
  return {
    dbPath: process.env.DB_PATH ?? "./flock.db",
    waAuthDir: process.env.WA_AUTH_DIR ?? "./wa-auth",
    anthropicApiKey: req("ANTHROPIC_API_KEY"),
    soulContractPath: process.env.SOUL_CONTRACT_PATH ?? "./flock-soul-contract.md",
    pricingPath: process.env.PRICING_PATH ?? "./flock-soul-pricing.md",
    maxTokens: Number(process.env.MAX_TOKENS ?? 2048),
    hermes: hermesUrl
      ? { baseUrl: hermesUrl, apiKey: process.env.HERMES_API_KEY, modelHeader: process.env.HERMES_MODEL_HEADER }
      : undefined,
    defaultPaymentMethod: (process.env.DEFAULT_PAYMENT_METHOD as PaymentMethod) ?? "stripe",
    stripe: {
      successUrl: process.env.STRIPE_SUCCESS_URL ?? "https://flockprints.com/payment/success",
      cancelUrl: process.env.STRIPE_CANCEL_URL ?? "https://flockprints.com/payment/cancel",
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      webhookPort: Number(process.env.STRIPE_WEBHOOK_PORT ?? 5001),
    },
    telegram: tgToken && tgChat ? { botToken: tgToken, chatId: tgChat } : undefined,
    integrations: {
      mockupUrl: process.env.MOCKUP_URL,
      supplierUrl: process.env.SUPPLIER_QUEUE_URL,
      deliveryUrl: process.env.DELIVERY_URL,
    },
    intervals: {
      schedulerMs: Number(process.env.SCHEDULER_MS ?? 3600_000),
      heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 900_000),
    },
    operatorJids: (process.env.OPERATOR_JIDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
}
