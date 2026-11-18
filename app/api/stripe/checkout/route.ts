import type Stripe from "stripe"
import { NextResponse } from "next/server"
import { z } from "zod"
import { SubscriptionStatus } from "@prisma/client"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { getStripe, STRIPE_PRICES, getAppUrl } from "@/lib/stripe"
import { getOrCreateStripeCustomer } from "@/lib/stripe-customer"
import { isSelfHosted } from "@/lib/self-hosted"

// New shape: { tier, interval }. A transitional union still accepts the old
// { price: "monthly"|"yearly" } body (= Pro) so a client bundle loaded before
// this deploy doesn't 400 mid-flight; it maps to the Pro tier.
// REMOVE after a few deploys (legacy client bundles drained): drop the second
// union member + the "price" branch in resolvePriceKey, keep only { tier, interval }.
const BodySchema = z.union([
  z.object({
    tier: z.enum(["pro", "lite"]),
    interval: z.enum(["monthly", "yearly"]),
  }),
  z.object({ price: z.enum(["monthly", "yearly"]) }),
])

function resolvePriceKey(
  body: z.infer<typeof BodySchema>
): "pro_monthly" | "pro_yearly" | "lite_monthly" | "lite_yearly" {
  if ("price" in body) return `pro_${body.price}`
  return `${body.tier}_${body.interval}`
}

export async function POST(request: Request) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId } = authResult

  // RAD-284: a self-hosted instance sells nothing — refuse even if STRIPE_* env
  // vars happen to be configured (direct POST / stale client bundle).
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "This instance is self-hosted — subscriptions are disabled.", code: "SELF_HOSTED" },
      { status: 400 }
    )
  }

  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  const priceKey = resolvePriceKey(parsed.data)
  const priceId = STRIPE_PRICES[priceKey]
  // Fail loud + early if this plan's price env var is unset (otherwise Stripe
  // gets an empty price id → opaque 500). Most likely Lite before its env vars
  // are configured.
  if (!priceId) {
    return NextResponse.json({ error: "Selected plan is not available" }, { status: 400 })
  }

  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user?.email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 })
  }

  const sub = await db.subscription.findUnique({ where: { userId } })
  if (sub) {
    const now = new Date()
    const covered =
      sub.status === SubscriptionStatus.ACTIVE ||
      sub.status === SubscriptionStatus.TRIALING ||
      (sub.status === SubscriptionStatus.PAST_DUE && sub.currentPeriodEnd > now)
    if (covered) {
      return NextResponse.json({ url: `${getAppUrl()}/settings/billing` })
    }
  }

  const customerId = await getOrCreateStripeCustomer({
    userId,
    email: user.email,
    existingStripeCustomerId: user.stripeCustomerId ?? null,
  })
  if (customerId !== user.stripeCustomerId) {
    await db.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } })
  }

  try {
    const stripe = getStripe()
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId,
      client_reference_id: userId,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      success_url: `${getAppUrl()}/settings/billing?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getAppUrl()}/settings/billing?canceled=1`,
      subscription_data: { metadata: { userId } },
      metadata: { userId },
    } as Parameters<typeof stripe.checkout.sessions.create>[0])
    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error("[stripe-checkout] error creating session", err)
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 })
  }
}
