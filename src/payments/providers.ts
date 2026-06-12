// payments/providers.ts
// Provider PORT + the manual provider. Stripe lives in stripe-provider.ts (imports the
// SDK; excluded from the offline typecheck). Money state changes NEVER pass through the
// LLM (§7) — providers are called only by PaymentOps, which is host-only.

import { PaymentMethod } from "../domain/types.js";

export interface ChargeArgs {
  amountCents: number;
  currency: string;
  /** Deterministic key; the provider passes it to Stripe's idempotency header too. */
  idempotencyKey: string;
  description: string;
  metadata?: Record<string, string>;
}

export type ChargeResult =
  | { status: "succeeded"; externalRef: string; paymentUrl?: string }
  | { status: "pending"; externalRef?: string; paymentUrl?: string } // manual methods clear later
  | { status: "failed"; externalRef?: string; error?: string };

export interface PaymentProvider {
  readonly method: PaymentMethod;
  charge(args: ChargeArgs): Promise<ChargeResult>;
  /**
   * §9 reconciliation: given an external_ref, report the settled status. Optional —
   * manual providers (Zelle/OXXO/cash) have no programmatic status and omit it.
   */
  getStatus?(externalRef: string): Promise<"succeeded" | "failed" | "pending">;
}

/**
 * Manual methods (Zelle/OXXO/cash): we record the intent and wait. Dan confirms
 * receipt via Penn; the host then marks the row succeeded. So charge() always
 * returns `pending` — it never auto-clears.
 */
export class ManualProvider implements PaymentProvider {
  constructor(public readonly method: PaymentMethod) {}
  async charge(_args: ChargeArgs): Promise<ChargeResult> {
    return { status: "pending" };
  }
}

/** Captures the USD rate at payment time (§7 currency handling). */
export interface FxSource {
  toUsd(currency: string): number;
}

/**
 * Development / USD-only deployments. Returns 1 for USD, and WARNS loudly for any
 * other currency so the silence doesn't corrupt margin reports at the data-eval phase.
 * Replace with LiveFxSource in production when non-USD payments are in use.
 */
export const usdOnlyFx: FxSource = {
  toUsd(currency: string): number {
    if (currency.toUpperCase() !== "USD") {
      console.warn(
        `[fx] usdOnlyFx called with currency=${currency} — rate is 1:1 PLACEHOLDER. ` +
          `Margin for this payment will be wrong. Wire a LiveFxSource before going multi-currency.`,
      );
    }
    return 1;
  },
};

/**
 * Production FX source. Holds a cached rate map refreshed on a timer; `toUsd()` is
 * synchronous (reads the cache) so it fits the PaymentOps call site without making
 * the hot path async. Wire it in index.ts:
 *
 *   const fx = new LiveFxSource(async (cur) => fetchRateFromYourAPI(cur));
 *   await fx.refresh(["MXN", "EUR"]);
 *   setInterval(() => void fx.refresh(["MXN", "EUR"]), 3_600_000);
 */
export class LiveFxSource implements FxSource {
  private cache = new Map<string, number>();

  constructor(
    private lookup: (currency: string) => Promise<number>,
  ) {}

  /** Call on boot and on a ~1-hour interval. Currencies not in the set keep their last value. */
  async refresh(currencies: string[]): Promise<void> {
    await Promise.all(
      currencies.map(async (cur) => {
        try {
          const rate = await this.lookup(cur.toUpperCase());
          this.cache.set(cur.toUpperCase(), rate);
        } catch (e) {
          console.error(`[fx] refresh failed for ${cur}: ${(e as Error).message} — using last known rate`);
        }
      }),
    );
  }

  toUsd(currency: string): number {
    const upper = currency.toUpperCase();
    if (upper === "USD") return 1;
    const rate = this.cache.get(upper);
    if (rate === undefined) {
      console.warn(
        `[fx] no cached rate for ${currency} — using 1:1 placeholder. ` +
          `Call fx.refresh([...]) on boot to load rates.`,
      );
      return 1;
    }
    return rate;
  }
}
