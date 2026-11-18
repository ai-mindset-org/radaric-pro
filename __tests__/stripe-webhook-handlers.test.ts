/**
 * stripe-webhook-handlers — TDD RED tests (RAD-148)
 *
 * Tests the 7 webhook handler functions that will live in
 * @/lib/stripe-webhook-handlers (module does not exist yet — all tests fail).
 *
 * mapStripeStatus is NOT mocked; real implementation runs end-to-end.
 * Spec criteria: AC-1 through AC-16, EC-1 through EC-3
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SubscriptionStatus } from "@prisma/client"

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    user: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    subscription: {
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

const stripeMock = {
  subscriptions: {
    retrieve: vi.fn(),
  },
}

vi.mock("@/lib/stripe", () => ({
  getStripe: () => stripeMock,
}))

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}))

import { db } from "@/lib/db"
const stripe = stripeMock
import * as Sentry from "@sentry/nextjs"
import {
  syncSubscriptionFromStripe,
  handleCheckoutCompleted,
  handleSubscriptionUpsert,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleCustomerDeleted,
  handleChargeDisputeCreated,
} from "@/lib/stripe-webhook-handlers"

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Stripe API 2026-03-25 shapes: current_period_* lives on items, not top level.
function makeStripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    customer: "cus_123",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    items: {
      data: [
        {
          price: { id: "price_monthly" },
          current_period_start: 1714569600,
          current_period_end: 1717248000,
        },
      ],
    },
    ...overrides,
  }
}

function makeCheckoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_123",
    customer: "cus_123",
    subscription: "sub_123",
    client_reference_id: "user_123",
    ...overrides,
  }
}

// Stripe API 2026-03-25: invoice.subscription moved to invoice.parent.subscription_details.subscription.
function makeInvoice(subRef: string | null = "sub_123", overrides: Record<string, unknown> = {}) {
  return {
    id: "in_123",
    customer: "cus_123",
    parent: subRef == null
      ? null
      : { subscription_details: { subscription: subRef } },
    ...overrides,
  }
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user_123",
    stripeCustomerId: "cus_123",
    email: "test@example.com",
    role: "USER",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// syncSubscriptionFromStripe
// ---------------------------------------------------------------------------

describe("syncSubscriptionFromStripe", () => {
  it("AC-1: calls stripe.subscriptions.retrieve exactly once with the given id", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_123")
  })

  it("AC-2: finds the user via db.user.findUnique with the customer id", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    expect(db.user.findUnique).toHaveBeenCalledTimes(1)
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { stripeCustomerId: "cus_123" },
    })
  })

  it("AC-3: upserts the Subscription row keyed by userId (create if missing, update if exists)", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    expect(db.subscription.upsert).toHaveBeenCalledTimes(1)
    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect(call.where).toEqual({ userId: "user_123" })
  })

  it("AC-4: upserted row has correct status (via mapStripeStatus), stripePriceId, currentPeriodStart/End as Date, cancelAtPeriodEnd, canceledAt, stripeSubscriptionId", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    const expectedPayload = {
      userId: "user_123",
      stripeSubscriptionId: "sub_123",
      status: SubscriptionStatus.ACTIVE,
      stripePriceId: "price_monthly",
      currentPeriodStart: new Date(1714569600 * 1000),
      currentPeriodEnd: new Date(1717248000 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    }

    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect(call.create).toEqual(expectedPayload)
    expect(call.update).toEqual(expectedPayload)
  })

  // -----------------------------------------------------------------------
  // AC-4b: cancelAtPeriodEnd derives from BOTH cancel_at_period_end and
  // cancel_at. Stripe API 2026-03-25 ("dahlia") encodes Customer Portal
  // "Cancel at end of billing period" as `cancel_at: <future_timestamp>` with
  // `cancel_at_period_end: false` — a semantic shift from older API versions
  // that only flipped the boolean. The handler must treat either signal as
  // "cancellation scheduled".
  // -----------------------------------------------------------------------

  it("AC-4b: dahlia portal cancel — cancel_at set to future, cancel_at_period_end:false → stores cancelAtPeriodEnd:true", async () => {
    const futureUnix = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 // +30 days
    const sub = makeStripeSubscription({
      cancel_at_period_end: false,
      cancel_at: futureUnix,
    })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect((call.create as { cancelAtPeriodEnd: boolean }).cancelAtPeriodEnd).toBe(true)
    expect((call.update as { cancelAtPeriodEnd: boolean }).cancelAtPeriodEnd).toBe(true)
  })

  it("AC-4b: legacy boolean signal — cancel_at_period_end:true, cancel_at:null → stores cancelAtPeriodEnd:true", async () => {
    const sub = makeStripeSubscription({
      cancel_at_period_end: true,
      cancel_at: null,
    })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect((call.create as { cancelAtPeriodEnd: boolean }).cancelAtPeriodEnd).toBe(true)
  })

  it("AC-4b: both signals present (defensive) → stores cancelAtPeriodEnd:true", async () => {
    const futureUnix = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    const sub = makeStripeSubscription({
      cancel_at_period_end: true,
      cancel_at: futureUnix,
    })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect((call.create as { cancelAtPeriodEnd: boolean }).cancelAtPeriodEnd).toBe(true)
  })

  it("AC-4b: both signals absent → stores cancelAtPeriodEnd:false", async () => {
    const sub = makeStripeSubscription({
      cancel_at_period_end: false,
      cancel_at: null,
    })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect((call.create as { cancelAtPeriodEnd: boolean }).cancelAtPeriodEnd).toBe(false)
  })

  it("AC-5: when customer is an object with id, reads customer.id", async () => {
    const sub = makeStripeSubscription({ customer: { id: "cus_obj_456" } })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser({ stripeCustomerId: "cus_obj_456" }) as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { stripeCustomerId: "cus_obj_456" },
    })
  })

  it("AC-5: when customer is a string, uses it directly", async () => {
    const sub = makeStripeSubscription({ customer: "cus_str_789" })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser({ stripeCustomerId: "cus_str_789" }) as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { stripeCustomerId: "cus_str_789" },
    })
  })

  it("AC-6: when db.user.findUnique returns null (orphan customer), captures Sentry warning and returns without upserting", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(null)

    await syncSubscriptionFromStripe("sub_123")

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("cus_123"),
      "warning"
    )
    expect(db.subscription.upsert).not.toHaveBeenCalled()
  })

  it("AC-4 (canceled): canceledAt is a Date when stripe provides canceled_at timestamp", async () => {
    const canceledAt = 1716000000
    const sub = makeStripeSubscription({
      status: "canceled",
      canceled_at: canceledAt,
    })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await syncSubscriptionFromStripe("sub_123")

    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect(call.create.canceledAt).toEqual(new Date(canceledAt * 1000))
    expect(call.update.canceledAt).toEqual(new Date(canceledAt * 1000))
    expect(call.create.status).toBe(SubscriptionStatus.CANCELED)
  })

  it("EC-1: when stripe.subscriptions.retrieve throws, the error propagates", async () => {
    vi.mocked(stripe.subscriptions.retrieve).mockRejectedValue(new Error("Stripe API error"))

    await expect(syncSubscriptionFromStripe("sub_bad")).rejects.toThrow("Stripe API error")
    expect(db.subscription.upsert).not.toHaveBeenCalled()
  })

  it("EC-3: handleSubscriptionUpsert with canceled status still calls sync; sync upsert records status CANCELED", async () => {
    const sub = makeStripeSubscription({ status: "canceled", canceled_at: 1716000000 })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await handleSubscriptionUpsert(makeStripeSubscription({ id: "sub_canceled", status: "canceled", canceled_at: 1716000000 }) as never)

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(db.subscription.upsert).toHaveBeenCalledTimes(1)
    const call = vi.mocked(db.subscription.upsert).mock.calls[0][0]
    expect(call.create.status).toBe(SubscriptionStatus.CANCELED)
  })
})

// ---------------------------------------------------------------------------
// handleCheckoutCompleted
// ---------------------------------------------------------------------------

describe("handleCheckoutCompleted", () => {
  it("AC-7: session.subscription as non-empty string → calls sync with that id", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    const session = makeCheckoutSession({ subscription: "sub_123" })
    await handleCheckoutCompleted(session as never)

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_123")
  })

  it("AC-8: session.subscription null → returns early (no sync call)", async () => {
    const session = makeCheckoutSession({ subscription: null })
    await handleCheckoutCompleted(session as never)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(db.subscription.upsert).not.toHaveBeenCalled()
  })

  it("AC-8: session.subscription undefined → returns early (no sync call)", async () => {
    const session = makeCheckoutSession({ subscription: undefined })
    await handleCheckoutCompleted(session as never)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(db.subscription.upsert).not.toHaveBeenCalled()
  })

  it("AC-9: session.subscription as object → calls sync with session.subscription.id", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    const session = makeCheckoutSession({ subscription: { id: "sub_from_obj" } })
    await handleCheckoutCompleted(session as never)

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_from_obj")
  })
})

// ---------------------------------------------------------------------------
// handleSubscriptionUpsert
// ---------------------------------------------------------------------------

describe("handleSubscriptionUpsert", () => {
  it("AC-10: extracts subscription.id and calls sync", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    await handleSubscriptionUpsert(makeStripeSubscription({ id: "sub_upsert_test" }) as never)

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_upsert_test")
  })
})

// ---------------------------------------------------------------------------
// handleInvoicePaid
// ---------------------------------------------------------------------------

describe("handleInvoicePaid", () => {
  it("AC-11: invoice.subscription as string → calls sync", async () => {
    const sub = makeStripeSubscription()
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    const invoice = makeInvoice("sub_123")
    await handleInvoicePaid(invoice as never)

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_123")
  })

  it("AC-12: invoice.subscription null → returns early", async () => {
    const invoice = makeInvoice(null)
    await handleInvoicePaid(invoice as never)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(db.subscription.upsert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// handleInvoicePaymentFailed
// ---------------------------------------------------------------------------

describe("handleInvoicePaymentFailed", () => {
  it("AC-13: invoice.subscription as string → calls sync", async () => {
    const sub = makeStripeSubscription({ status: "past_due" })
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub as never)
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    vi.mocked(db.subscription.upsert).mockResolvedValue({} as never)

    const invoice = makeInvoice("sub_123")
    await handleInvoicePaymentFailed(invoice as never)

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_123")
  })

  it("AC-14: invoice.subscription null → returns early", async () => {
    const invoice = makeInvoice(null)
    await handleInvoicePaymentFailed(invoice as never)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(db.subscription.upsert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// handleCustomerDeleted
// ---------------------------------------------------------------------------

describe("handleCustomerDeleted", () => {
  it("AC-15: calls db.subscription.deleteMany before db.user.updateMany, both with correct args", async () => {
    vi.mocked(db.subscription.deleteMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(db.user.updateMany).mockResolvedValue({ count: 1 } as never)

    const callOrder: string[] = []
    vi.mocked(db.subscription.deleteMany).mockImplementation(async () => {
      callOrder.push("deleteMany")
      return { count: 1 }
    })
    vi.mocked(db.user.updateMany).mockImplementation(async () => {
      callOrder.push("updateMany")
      return { count: 1 }
    })

    const customer = { id: "cus_123", object: "customer" }
    await handleCustomerDeleted(customer as never)

    expect(db.subscription.deleteMany).toHaveBeenCalledTimes(1)
    expect(db.subscription.deleteMany).toHaveBeenCalledWith({
      where: { user: { stripeCustomerId: "cus_123" } },
    })

    expect(db.user.updateMany).toHaveBeenCalledTimes(1)
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: "cus_123" },
      data: { stripeCustomerId: null },
    })

    expect(callOrder.indexOf("deleteMany")).toBeLessThan(callOrder.indexOf("updateMany"))
  })
})

// ---------------------------------------------------------------------------
// handleChargeDisputeCreated
// ---------------------------------------------------------------------------

describe("handleChargeDisputeCreated", () => {
  it("AC-16: calls Sentry.captureMessage with level 'error', message containing dispute id and amount; does not touch db", async () => {
    const dispute = {
      id: "dp_1234567890",
      amount: 5900,
      currency: "usd",
      charge: "ch_abc",
    }

    await handleChargeDisputeCreated(dispute as never)

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
    const [message, level] = vi.mocked(Sentry.captureMessage).mock.calls[0]
    expect(level).toBe("error")
    expect(message).toContain("dp_1234567890")
    expect(message).toContain("5900")

    expect(db.subscription.upsert).not.toHaveBeenCalled()
    expect(db.subscription.deleteMany).not.toHaveBeenCalled()
    expect(db.user.updateMany).not.toHaveBeenCalled()
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })
})
