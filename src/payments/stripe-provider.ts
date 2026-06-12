// payments/stripe-provider.ts
// Stripe adapter. Excluded from the offline typecheck (imports the SDK).
//
// Charges are created as Stripe Checkout Sessions so a shareable payment URL is
// returned and delivered to the client over WhatsApp. getStatus() powers §9
// reconciliation and handles both Checkout Session IDs (cs_...) and legacy
// PaymentIntent IDs (pi_...) so orders created before this migration still reconcile.

import Stripe from "stripe";
import { PaymentProvider, ChargeArgs, ChargeResult } from "./providers.js";
import { PaymentMethod } from "../domain/types.js";

export class StripeProvider implements PaymentProvider {
  readonly method: PaymentMethod = "stripe";
  private stripe: Stripe;

  constructor(
    secretKey: string,
    private successUrl: string,
    private cancelUrl: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async charge(args: ChargeArgs): Promise<ChargeResult> {
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: args.currency.toLowerCase(),
                product_data: { name: args.description },
                unit_amount: args.amountCents,
              },
              quantity: 1,
            },
          ],
          metadata: args.metadata ?? {},
          success_url: this.successUrl,
          cancel_url: this.cancelUrl,
        },
        { idempotencyKey: args.idempotencyKey },
      );

      const paymentUrl = session.url ?? undefined;

      if (session.payment_status === "paid") {
        return { status: "succeeded", externalRef: session.id, paymentUrl };
      }
      // open / incomplete — client must complete via the URL.
      return { status: "pending", externalRef: session.id, paymentUrl };
    } catch (e) {
      return { status: "failed", error: (e as Error).message };
    }
  }

  async getStatus(externalRef: string): Promise<"succeeded" | "failed" | "pending"> {
    if (externalRef.startsWith("cs_")) {
      const session = await this.stripe.checkout.sessions.retrieve(externalRef);
      if (session.payment_status === "paid") return "succeeded";
      if (session.status === "expired") return "failed";
      return "pending";
    }
    // Legacy PaymentIntent support for pre-migration rows.
    const intent = await this.stripe.paymentIntents.retrieve(externalRef);
    if (intent.status === "succeeded") return "succeeded";
    if (intent.status === "canceled") return "failed";
    return "pending";
  }
}
