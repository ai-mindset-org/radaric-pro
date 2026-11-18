import type Stripe from "stripe"
import { NextResponse } from "next/server"
import { z } from "zod"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { isSelfHosted } from "@/lib/self-hosted"
import { db } from "@/lib/db"
import { getStripe, getAppUrl } from "@/lib/stripe"

export const runtime = "nodejs"

const BodySchema = z.object({
  flow: z.enum(["switch"]).optional(),
})

export async function POST(request: Request): Promise<Response> {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId } = authResult

  // RAD-284: self-hosted instances have no customer portal.
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "This instance is self-hosted — billing is disabled.", code: "SELF_HOSTED" },
      { status: 400 }
    )
  }

  const rawBody = await request.json().catch(() => ({}))
  const parsed = BodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }
  const flow = parsed.data.flow

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { subscription: true },
  })
  if (!user?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account found. Subscribe first." },
      { status: 400 }
    )
  }

  try {
    const stripe = getStripe()
    const sessionParams: Stripe.BillingPortal.SessionCreateParams = {
      customer: user.stripeCustomerId,
      return_url: `${getAppUrl()}/settings/billing`,
    }

    // flow=switch lands the user directly on the plan-update screen with
    // proration preview. Requires Stripe portal config to have the
    // "Subscription update" feature enabled and both prices listed (RAD-227).
    // Falls back to the default portal landing if the user has no active sub
    // — Stripe rejects subscription_update flow_data without a sub id.
    if (flow === "switch" && user.subscription?.stripeSubscriptionId) {
      sessionParams.flow_data = {
        type: "subscription_update",
        subscription_update: {
          subscription: user.subscription.stripeSubscriptionId,
        },
      }
    }

    const session = await stripe.billingPortal.sessions.create(sessionParams)
    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error("[stripe-portal] error creating session", err)
    return NextResponse.json(
      { error: "Failed to create portal session" },
      { status: 500 }
    )
  }
}
