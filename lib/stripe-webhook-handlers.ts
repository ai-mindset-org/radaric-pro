import type Stripe from "stripe"
import { db } from "@/lib/db"
import { getStripe } from "@/lib/stripe"
import { mapStripeStatus } from "@/lib/stripe-status-map"
import * as Sentry from "@sentry/nextjs"

// ---------------------------------------------------------------------------
// Stripe API normalization layer
// ---------------------------------------------------------------------------
//
// Stripe API 2026-03-25 ("dahlia") moved several fields from where they used
// to live. Localize those reads here so future API changes need updating one
// place each.

// `current_period_start/end` moved from Subscription top-level to per-item
// (subscription items can have independent billing cycles).
function subscriptionPeriod(sub: Stripe.Subscription): {
  start: Date
  end: Date
  priceId: string
} {
  const firstItem = sub.items.data[0]
  if (!firstItem) {
    throw new Error(`Stripe subscription ${sub.id} has no items`)
  }
  return {
    start: new Date(firstItem.current_period_start * 1000),
    end: new Date(firstItem.current_period_end * 1000),
    priceId: firstItem.price.id,
  }
}

// `invoice.subscription` moved to `invoice.parent.subscription_details.subscription`.
function invoiceSubscriptionRef(
  invoice: Stripe.Invoice
): string | { id: string } | null | undefined {
  return invoice.parent?.subscription_details?.subscription ?? null
}

// `subscription.customer` is a string when not expanded, an object when expanded.
function subscriptionCustomerId(sub: Stripe.Subscription): string {
  return typeof sub.customer === "object" && sub.customer !== null
    ? (sub.customer as { id: string }).id
    : (sub.customer as string)
}

// Stripe API 2026-03-25 ("dahlia") encodes Customer Portal "Cancel at end of
// billing period" as `cancel_at: <future_timestamp>` while keeping
// `cancel_at_period_end: false` — older API versions and direct API calls with
// --cancel-at-period-end flip the boolean instead. Treat either signal as
// "cancellation scheduled" so the UI's "Access until X" copy stays accurate.
function isCancelScheduled(sub: Stripe.Subscription): boolean {
  if (sub.cancel_at_period_end === true) return true
  if (sub.cancel_at !== null && sub.cancel_at !== undefined) return true
  return false
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function syncSubscriptionFromStripe(stripeSubscriptionId: string): Promise<void> {
  const stripe = getStripe()
  const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId)

  const customerId = subscriptionCustomerId(sub)
  const user = await db.user.findUnique({ where: { stripeCustomerId: customerId } })

  if (!user) {
    Sentry.captureMessage(
      `No user found for Stripe customer ${customerId} — orphan subscription ${sub.id}`,
      "warning"
    )
    return
  }

  const period = subscriptionPeriod(sub)
  const payload = {
    userId: user.id,
    stripeSubscriptionId: sub.id,
    status: mapStripeStatus(sub.status),
    stripePriceId: period.priceId,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: isCancelScheduled(sub),
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
  }

  await db.subscription.upsert({
    where: { userId: user.id },
    create: payload,
    update: payload,
  })
}

async function syncFromReference(
  ref: string | { id: string } | null | undefined
): Promise<void> {
  if (ref == null) return
  await syncSubscriptionFromStripe(typeof ref === "string" ? ref : ref.id)
}

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  await syncFromReference(session.subscription)
}

export async function handleSubscriptionUpsert(subscription: Stripe.Subscription): Promise<void> {
  await syncSubscriptionFromStripe(subscription.id)
}

export async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  await syncFromReference(invoiceSubscriptionRef(invoice))
}

export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  await syncFromReference(invoiceSubscriptionRef(invoice))
}

export async function handleCustomerDeleted(
  customer: Stripe.Customer | Stripe.DeletedCustomer
): Promise<void> {
  // Atomic: clear sub + nullify pointer in one round-trip so a partial failure
  // can't leave the user with stripeCustomerId pointing at a deleted customer.
  await db.$transaction([
    db.subscription.deleteMany({
      where: { user: { stripeCustomerId: customer.id } },
    }),
    db.user.updateMany({
      where: { stripeCustomerId: customer.id },
      data: { stripeCustomerId: null },
    }),
  ])
}

export async function handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  Sentry.captureMessage(
    `Stripe dispute created: ${dispute.id} — amount ${dispute.amount}`,
    "error"
  )
}
