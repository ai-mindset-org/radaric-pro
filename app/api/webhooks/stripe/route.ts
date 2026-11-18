/**
 * POST /api/webhooks/stripe — Stripe webhook route handler
 *
 * Verifies Stripe signatures, enforces idempotency via StripeEvent PK,
 * dispatches to F3 handlers. The StripeEvent insert acts as an idempotency
 * fence (P2002 unique-violation on duplicate event id returns 200 early),
 * but the handler dispatch runs OUTSIDE any DB transaction so Stripe API
 * calls inside syncSubscriptionFromStripe don't hold a Postgres connection.
 * On handler failure, the idempotency row is deleted so Stripe retries.
 * RAD-148
 */

import type Stripe from "stripe"
import { NextResponse } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { getStripe } from "@/lib/stripe"
import { db } from "@/lib/db"
import {
  handleCheckoutCompleted,
  handleSubscriptionUpsert,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleCustomerDeleted,
  handleChargeDisputeCreated,
} from "@/lib/stripe-webhook-handlers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function dispatchEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
      return
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionUpsert(event.data.object as Stripe.Subscription)
      return
    case "invoice.paid":
      await handleInvoicePaid(event.data.object as Stripe.Invoice)
      return
    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)
      return
    case "customer.deleted":
      await handleCustomerDeleted(
        event.data.object as Stripe.Customer | Stripe.DeletedCustomer
      )
      return
    case "charge.dispute.created":
      await handleChargeDisputeCreated(event.data.object as Stripe.Dispute)
      return
    default:
      // Unhandled event type — return 200 so Stripe doesn't retry indefinitely
      return
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 503 }
    )
  }

  const body = await request.text()

  const sig = request.headers.get("stripe-signature")
  if (!sig) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    )
  }

  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed", (err as Error).message)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  // Idempotency fence: insert the event row first. Duplicate delivery trips the
  // unique PK and we return 200 no-op. This happens OUTSIDE a transaction so
  // the subsequent Stripe API call inside dispatchEvent doesn't hold a Postgres
  // connection open during HTTP round-trip.
  try {
    await db.stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return new Response(null, { status: 200 })
    }
    Sentry.captureException(err, {
      tags: { source: "stripe-webhook", stage: "idempotency-insert", eventType: event.type, eventId: event.id },
    })
    console.error("[stripe-webhook] idempotency insert failed", err)
    return new Response("Idempotency insert failed", { status: 500 })
  }

  // Dispatch handlers. On failure, delete the idempotency row so Stripe retries.
  try {
    await dispatchEvent(event)
  } catch (err) {
    Sentry.captureException(err, {
      tags: { source: "stripe-webhook", stage: "handler", eventType: event.type, eventId: event.id },
    })
    console.error("[stripe-webhook] handler error", err)
    await db.stripeEvent.delete({ where: { id: event.id } }).catch(() => {})
    return new Response("Handler error", { status: 500 })
  }

  return new Response(null, { status: 200 })
}
