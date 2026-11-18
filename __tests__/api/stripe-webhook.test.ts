/**
 * POST /api/webhooks/stripe — Stripe webhook route handler
 *
 * Tests: signature verification, event dispatch to handlers, idempotency,
 * transaction wrapping, error handling.
 * RAD-148
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Stripe from "stripe"

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any import that pulls in the mocked module
// ---------------------------------------------------------------------------

const stripeMock = {
  webhooks: {
    constructEvent: vi.fn((body: string, sig: string, secret: string) =>
      Stripe.webhooks.constructEvent(body, sig, secret)
    ),
  },
}

vi.mock("@/lib/stripe", () => ({
  getStripe: () => stripeMock,
}))

// db mock — stripeEvent.create is the idempotency fence; stripeEvent.delete
// is called on handler failure to let Stripe retry.
vi.mock("@/lib/db", () => ({
  db: {
    stripeEvent: {
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}))

vi.mock("@/lib/stripe-webhook-handlers", () => ({
  handleCheckoutCompleted: vi.fn().mockResolvedValue(undefined),
  handleSubscriptionUpsert: vi.fn().mockResolvedValue(undefined),
  handleInvoicePaid: vi.fn().mockResolvedValue(undefined),
  handleInvoicePaymentFailed: vi.fn().mockResolvedValue(undefined),
  handleCustomerDeleted: vi.fn().mockResolvedValue(undefined),
  handleChargeDisputeCreated: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { db } from "@/lib/db"
const stripe = stripeMock
import {
  handleCheckoutCompleted,
  handleSubscriptionUpsert,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleCustomerDeleted,
  handleChargeDisputeCreated,
} from "@/lib/stripe-webhook-handlers"
import { POST } from "@/app/api/webhooks/stripe/route"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const STRIPE_WEBHOOK_SECRET = "whsec_test_1234567890abcdef"

function signRequest(payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
    timestamp,
  })
}

function makeEvent(type: string, data: unknown, eventId = "evt_test_1"): string {
  return JSON.stringify({
    id: eventId,
    object: "event",
    type,
    data: { object: data },
    created: Math.floor(Date.now() / 1000),
  })
}

function makeRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (signature) headers["stripe-signature"] = signature
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers,
    body,
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.stripeEvent.create).mockResolvedValue({} as never)
  vi.mocked(db.stripeEvent.delete).mockResolvedValue({} as never)
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/stripe", () => {
  // -------------------------------------------------------------------------
  // AC-1: valid signature + known type → 200
  // -------------------------------------------------------------------------
  it("AC-1: valid signature with known event type returns 200", async () => {
    const payload = makeEvent("checkout.session.completed", { id: "cs_1" })
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
  })

  // -------------------------------------------------------------------------
  // AC-2: missing stripe-signature header → 400
  // -------------------------------------------------------------------------
  it("AC-2: missing stripe-signature header returns 400", async () => {
    const payload = makeEvent("checkout.session.completed", { id: "cs_1" })
    const res = await POST(makeRequest(payload, null))
    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // AC-3: invalid signature → 400
  // -------------------------------------------------------------------------
  it("AC-3: invalid signature returns 400", async () => {
    const payload = makeEvent("checkout.session.completed", { id: "cs_1" })
    const res = await POST(makeRequest(payload, "t=12345,v1=deadbeef"))
    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // AC-4: valid signature with timestamp outside 300s tolerance → 400
  // -------------------------------------------------------------------------
  it("AC-4: valid signature with timestamp outside 300s tolerance returns 400 (replay protection)", async () => {
    const payload = makeEvent("checkout.session.completed", { id: "cs_1" })
    const staleTimestamp = Math.floor(Date.now() / 1000) - 400 // 400 s ago
    const sig = signRequest(payload, staleTimestamp)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // AC-5: checkout.session.completed → handleCheckoutCompleted called once
  // -------------------------------------------------------------------------
  it("AC-5: checkout.session.completed calls handleCheckoutCompleted with event data object", async () => {
    const sessionData = { id: "cs_test_abc", object: "checkout.session" }
    const payload = makeEvent("checkout.session.completed", sessionData)
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
    expect(handleCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(handleCheckoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_test_abc" })
    )
  })

  // -------------------------------------------------------------------------
  // AC-6: customer.subscription.* → handleSubscriptionUpsert called once
  // -------------------------------------------------------------------------
  describe("AC-6: subscription events dispatch to handleSubscriptionUpsert", () => {
    const subscriptionData = { id: "sub_test_xyz", object: "subscription" }

    it("AC-6a: customer.subscription.created calls handleSubscriptionUpsert", async () => {
      const payload = makeEvent("customer.subscription.created", subscriptionData)
      const sig = signRequest(payload)
      const res = await POST(makeRequest(payload, sig))
      expect(res.status).toBe(200)
      expect(handleSubscriptionUpsert).toHaveBeenCalledTimes(1)
      expect(handleSubscriptionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sub_test_xyz" })
      )
    })

    it("AC-6b: customer.subscription.updated calls handleSubscriptionUpsert", async () => {
      const payload = makeEvent("customer.subscription.updated", subscriptionData)
      const sig = signRequest(payload)
      const res = await POST(makeRequest(payload, sig))
      expect(res.status).toBe(200)
      expect(handleSubscriptionUpsert).toHaveBeenCalledTimes(1)
      expect(handleSubscriptionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sub_test_xyz" })
      )
    })

    it("AC-6c: customer.subscription.deleted calls handleSubscriptionUpsert", async () => {
      const payload = makeEvent("customer.subscription.deleted", subscriptionData)
      const sig = signRequest(payload)
      const res = await POST(makeRequest(payload, sig))
      expect(res.status).toBe(200)
      expect(handleSubscriptionUpsert).toHaveBeenCalledTimes(1)
      expect(handleSubscriptionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sub_test_xyz" })
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC-7: invoice.paid → handleInvoicePaid called once
  // -------------------------------------------------------------------------
  it("AC-7: invoice.paid calls handleInvoicePaid with event data object", async () => {
    const invoiceData = { id: "in_test_paid", object: "invoice" }
    const payload = makeEvent("invoice.paid", invoiceData)
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
    expect(handleInvoicePaid).toHaveBeenCalledTimes(1)
    expect(handleInvoicePaid).toHaveBeenCalledWith(expect.objectContaining({ id: "in_test_paid" }))
  })

  // -------------------------------------------------------------------------
  // AC-8: invoice.payment_failed → handleInvoicePaymentFailed called once
  // -------------------------------------------------------------------------
  it("AC-8: invoice.payment_failed calls handleInvoicePaymentFailed with event data object", async () => {
    const invoiceData = { id: "in_test_failed", object: "invoice" }
    const payload = makeEvent("invoice.payment_failed", invoiceData)
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
    expect(handleInvoicePaymentFailed).toHaveBeenCalledTimes(1)
    expect(handleInvoicePaymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "in_test_failed" })
    )
  })

  // -------------------------------------------------------------------------
  // AC-9: customer.deleted → handleCustomerDeleted called once
  // -------------------------------------------------------------------------
  it("AC-9: customer.deleted calls handleCustomerDeleted with event data object", async () => {
    const customerData = { id: "cus_test_del", object: "customer" }
    const payload = makeEvent("customer.deleted", customerData)
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
    expect(handleCustomerDeleted).toHaveBeenCalledTimes(1)
    expect(handleCustomerDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cus_test_del" })
    )
  })

  // -------------------------------------------------------------------------
  // AC-10: charge.dispute.created → handleChargeDisputeCreated called once
  // -------------------------------------------------------------------------
  it("AC-10: charge.dispute.created calls handleChargeDisputeCreated with event data object", async () => {
    const disputeData = { id: "dp_test_1", object: "dispute", amount: 5000 }
    const payload = makeEvent("charge.dispute.created", disputeData)
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
    expect(handleChargeDisputeCreated).toHaveBeenCalledTimes(1)
    expect(handleChargeDisputeCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dp_test_1" })
    )
  })

  // -------------------------------------------------------------------------
  // AC-11: unhandled type → 200, no handler called
  // -------------------------------------------------------------------------
  it("AC-11: unhandled event type (customer.created) returns 200 without calling any handler", async () => {
    const payload = makeEvent("customer.created", { id: "cus_new" })
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
    expect(handleCheckoutCompleted).not.toHaveBeenCalled()
    expect(handleSubscriptionUpsert).not.toHaveBeenCalled()
    expect(handleInvoicePaid).not.toHaveBeenCalled()
    expect(handleInvoicePaymentFailed).not.toHaveBeenCalled()
    expect(handleCustomerDeleted).not.toHaveBeenCalled()
    expect(handleChargeDisputeCreated).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC-12: stripeEvent row persisted as a pure idempotency fence (id + type)
  // -------------------------------------------------------------------------
  it("AC-12: persists stripeEvent row with id and type only — pure idempotency fence, no payload (RAD-223 B2)", async () => {
    const payload = makeEvent("invoice.paid", { id: "in_ac12" }, "evt_ac12")
    const sig = signRequest(payload)
    await POST(makeRequest(payload, sig))
    expect(db.stripeEvent.create).toHaveBeenCalledWith({
      data: {
        id: "evt_ac12",
        type: "invoice.paid",
      },
    })
  })

  // -------------------------------------------------------------------------
  // AC-13: duplicate event id (P2002) → 200 early, no handler call
  // -------------------------------------------------------------------------
  it("AC-13: duplicate event id (Prisma P2002) returns 200 without calling handlers", async () => {
    vi.mocked(db.stripeEvent.create).mockRejectedValueOnce({ code: "P2002" })
    const payload = makeEvent("invoice.paid", { id: "in_dup" }, "evt_duplicate")
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(200)
    expect(handleInvoicePaid).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC-14: handler throws → 500, idempotency row deleted so Stripe retries
  // -------------------------------------------------------------------------
  it("AC-14: handler throw results in 500 response", async () => {
    vi.mocked(handleInvoicePaid).mockRejectedValueOnce(new Error("handler blew up"))
    const payload = makeEvent("invoice.paid", { id: "in_err" }, "evt_err_1")
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(500)
  })

  it("AC-14: handler throw deletes the idempotency row so Stripe retries", async () => {
    vi.mocked(handleInvoicePaid).mockRejectedValueOnce(new Error("handler blew up"))
    const payload = makeEvent("invoice.paid", { id: "in_err" }, "evt_err_rollback")
    const sig = signRequest(payload)
    await POST(makeRequest(payload, sig))
    expect(db.stripeEvent.delete).toHaveBeenCalledWith({ where: { id: "evt_err_rollback" } })
  })

  // -------------------------------------------------------------------------
  // AC-15: idempotency is enforced via the stripeEvent.id PK, not $transaction.
  // The handler dispatch happens OUTSIDE any DB transaction so Stripe API
  // calls don't hold Postgres connections. Verify the order: stripeEvent.create
  // runs before any handler is called.
  // -------------------------------------------------------------------------
  it("AC-15: stripeEvent.create is called before the handler dispatch", async () => {
    const callOrder: string[] = []
    vi.mocked(db.stripeEvent.create).mockImplementationOnce(async () => {
      callOrder.push("stripeEvent.create")
      return {} as never
    })
    vi.mocked(handleInvoicePaid).mockImplementationOnce(async () => {
      callOrder.push("handleInvoicePaid")
    })
    const payload = makeEvent("invoice.paid", { id: "in_order" }, "evt_order_1")
    const sig = signRequest(payload)
    await POST(makeRequest(payload, sig))
    expect(callOrder).toEqual(["stripeEvent.create", "handleInvoicePaid"])
  })

  // -------------------------------------------------------------------------
  // AC-16: missing STRIPE_WEBHOOK_SECRET → 503
  // -------------------------------------------------------------------------
  it("AC-16: missing STRIPE_WEBHOOK_SECRET env var returns 503", async () => {
    vi.unstubAllEnvs()
    delete process.env.STRIPE_WEBHOOK_SECRET
    const payload = makeEvent("invoice.paid", { id: "in_no_secret" })
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(503)
  })

  // -------------------------------------------------------------------------
  // EC-1: empty body → 400
  // -------------------------------------------------------------------------
  it("EC-1: empty body string returns 400 (constructEvent throws)", async () => {
    const sig = signRequest("")
    const res = await POST(makeRequest("", sig))
    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // EC-2: signature verification throws a generic Error → 400 with message
  // -------------------------------------------------------------------------
  it("EC-2: constructEvent throwing a generic Error returns 400 with error message", async () => {
    // Temporarily override the stripe mock to throw a generic error
    vi.mocked(stripe.webhooks.constructEvent).mockImplementationOnce(() => {
      throw new Error("unexpected verification failure")
    })
    const payload = makeEvent("invoice.paid", { id: "in_generic_err" })
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(400)
    // Error message must be sanitized — never leak raw SDK internals to the client
    const body = await res.json()
    expect(body.error).toBe("Invalid signature")
  })

  // -------------------------------------------------------------------------
  // ERR-1: constructEvent throws for any reason → always 400, never 500
  // -------------------------------------------------------------------------
  it("ERR-1: constructEvent throwing for any reason returns 400 (never 500)", async () => {
    vi.mocked(stripe.webhooks.constructEvent).mockImplementationOnce(() => {
      throw new Error("some random crypto error")
    })
    const payload = makeEvent("checkout.session.completed", { id: "cs_err" })
    const sig = signRequest(payload)
    const res = await POST(makeRequest(payload, sig))
    expect(res.status).toBe(400)
    expect(res.status).not.toBe(500)
  })
})
