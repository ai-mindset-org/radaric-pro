/**
 * POST /api/stripe/checkout — Stripe checkout session creation
 *
 * Tests: auth guard, input validation, active-subscription guard,
 * Stripe customer upsert, session.create params, success response.
 * RAD-148
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SubscriptionStatus } from "@prisma/client"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
    },
  },
}))

const stripeMock = {
  checkout: {
    sessions: {
      create: vi.fn(),
    },
  },
}

vi.mock("@/lib/stripe", () => ({
  getStripe: () => stripeMock,
  STRIPE_PRICES: {
    pro_monthly: "price_test_monthly",
    pro_yearly: "price_test_yearly",
    lite_monthly: "price_test_lite_monthly",
    lite_yearly: "price_test_lite_yearly",
  },
  getAppUrl: vi.fn(() => "https://radaric.pro"),
}))

vi.mock("@/lib/stripe-customer", () => ({
  getOrCreateStripeCustomer: vi.fn(),
}))

import { requireAuth } from "@/lib/auth-utils"
import { db } from "@/lib/db"
const stripe = stripeMock
import { getOrCreateStripeCustomer } from "@/lib/stripe-customer"
import { POST } from "@/app/api/stripe/checkout/route"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: authenticated user
  vi.mocked(requireAuth).mockResolvedValue({ userId: "user_123", role: "USER" })
  vi.mocked(db.user.findUnique).mockResolvedValue({
    id: "user_123",
    email: "test@example.com",
    stripeCustomerId: "cus_existing",
  } as never)
  vi.mocked(db.subscription.findUnique).mockResolvedValue(null)
  vi.mocked(getOrCreateStripeCustomer).mockResolvedValue("cus_existing")
  vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
    id: "cs_test_123",
    url: "https://checkout.stripe.com/c/pay/cs_test_123",
  } as never)
})

describe("POST /api/stripe/checkout", () => {
  describe("Auth guard", () => {
    it("AC-1: when requireAuth returns a Response (unauthenticated), returns it without touching DB or Stripe", async () => {
      const errorResponse = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
      vi.mocked(requireAuth).mockResolvedValue(errorResponse as never)

      const res = await POST(makeRequest({ price: "monthly" }))

      expect(res.status).toBe(401)
      expect(db.user.findUnique).not.toHaveBeenCalled()
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })
  })

  describe("Input validation", () => {
    it("AC-2: returns 400 for invalid price value { price: 'invalid' }", async () => {
      const res = await POST(makeRequest({ price: "invalid" }))
      expect(res.status).toBe(400)
    })

    it("AC-2: returns 400 for missing price field {}", async () => {
      const res = await POST(makeRequest({}))
      expect(res.status).toBe(400)
    })

    it("AC-2: returns 400 for malformed JSON body", async () => {
      const res = await POST(makeRequest("not-json{{{"))
      expect(res.status).toBe(400)
    })

    it("AC-3: returns 400 with 'Email required' when user.email is null", async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        id: "user_123",
        email: null,
        stripeCustomerId: null,
      } as never)

      const res = await POST(makeRequest({ price: "monthly" }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/email required/i)
    })
  })

  describe("Active subscription guard", () => {
    it.each([
      [SubscriptionStatus.ACTIVE],
      [SubscriptionStatus.TRIALING],
      [SubscriptionStatus.PAST_DUE],
    ])(
      "AC-4: returns billing URL without calling stripe when subscription status is %s and currentPeriodEnd is in the future",
      async (status) => {
        vi.mocked(db.subscription.findUnique).mockResolvedValue({
          id: "sub_123",
          status,
          currentPeriodEnd: new Date(Date.now() + 86400 * 1000),
        } as never)

        const res = await POST(makeRequest({ price: "monthly" }))

        expect(res.status).toBe(200)
        const json = await res.json()
        expect(json.url).toBe("https://radaric.pro/settings/billing")
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
      },
    )

    it.each([
      [SubscriptionStatus.CANCELED],
      [SubscriptionStatus.UNPAID],
    ])(
      "AC-5: proceeds to create checkout session when subscription status is %s",
      async (status) => {
        vi.mocked(db.subscription.findUnique).mockResolvedValue({
          id: "sub_canceled",
          status,
          currentPeriodEnd: new Date(Date.now() - 86400 * 1000),
        } as never)

        const res = await POST(makeRequest({ price: "monthly" }))

        expect(stripe.checkout.sessions.create).toHaveBeenCalled()
        expect(res.status).toBe(200)
      },
    )

    it("AC-6: proceeds to create checkout session when user has no subscription (null)", async () => {
      vi.mocked(db.subscription.findUnique).mockResolvedValue(null)

      const res = await POST(makeRequest({ price: "monthly" }))

      expect(stripe.checkout.sessions.create).toHaveBeenCalled()
      expect(res.status).toBe(200)
    })
  })

  describe("Stripe customer upsert", () => {
    it("AC-7: calls getOrCreateStripeCustomer with userId, email, and existingStripeCustomerId", async () => {
      await POST(makeRequest({ price: "monthly" }))

      expect(getOrCreateStripeCustomer).toHaveBeenCalledWith({
        userId: "user_123",
        email: "test@example.com",
        existingStripeCustomerId: "cus_existing",
      })
    })

    it("AC-8: updates user.stripeCustomerId when getOrCreateStripeCustomer returns a new id", async () => {
      vi.mocked(getOrCreateStripeCustomer).mockResolvedValue("cus_new_456")

      await POST(makeRequest({ price: "monthly" }))

      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "user_123" },
        data: { stripeCustomerId: "cus_new_456" },
      })
    })

    it("AC-9: does NOT call db.user.update when getOrCreateStripeCustomer returns the same id", async () => {
      vi.mocked(getOrCreateStripeCustomer).mockResolvedValue("cus_existing")

      await POST(makeRequest({ price: "monthly" }))

      expect(db.user.update).not.toHaveBeenCalled()
    })
  })

  describe("stripe.checkout.sessions.create params", () => {
    it("AC-10: calls session.create with the full expected params object", async () => {
      await POST(makeRequest({ price: "monthly" }))

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "subscription",
          line_items: [{ price: "price_test_monthly", quantity: 1 }],
          customer: "cus_existing",
          client_reference_id: "user_123",
          allow_promotion_codes: true,
          billing_address_collection: "auto",
          success_url: expect.stringContaining("/settings/billing?success=1"),
          cancel_url: expect.stringContaining("/settings/billing?canceled=1"),
          subscription_data: { metadata: { userId: "user_123" } },
          metadata: { userId: "user_123" },
        }),
      )
    })

    it("AC-11: uses STRIPE_PRICES.monthly ('price_test_monthly') when body.price is 'monthly'", async () => {
      await POST(makeRequest({ price: "monthly" }))

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: "price_test_monthly", quantity: 1 }],
        }),
      )
    })

    it("AC-12: uses STRIPE_PRICES.yearly ('price_test_yearly') when body.price is 'yearly'", async () => {
      await POST(makeRequest({ price: "yearly" }))

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: "price_test_yearly", quantity: 1 }],
        }),
      )
    })

    it.each([
      ["pro", "monthly", "price_test_monthly"],
      ["pro", "yearly", "price_test_yearly"],
      ["lite", "monthly", "price_test_lite_monthly"],
      ["lite", "yearly", "price_test_lite_yearly"],
    ])("maps { tier: %s, interval: %s } to %s", async (tier, interval, price) => {
      await POST(makeRequest({ tier, interval }))

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price, quantity: 1 }],
        }),
      )
    })

    it("rejects an unknown tier with 400", async () => {
      const res = await POST(makeRequest({ tier: "enterprise", interval: "monthly" }))
      expect(res.status).toBe(400)
    })
  })

  describe("Success response", () => {
    it("AC-13: returns JSON { url: session.url } with status 200 on success", async () => {
      const res = await POST(makeRequest({ price: "monthly" }))

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.url).toBe("https://checkout.stripe.com/c/pay/cs_test_123")
    })
  })

  describe("Error handling", () => {
    it("EC-1: returns 500 when stripe.checkout.sessions.create throws", async () => {
      vi.mocked(stripe.checkout.sessions.create).mockRejectedValue(
        new Error("Stripe network error"),
      )

      const res = await POST(makeRequest({ price: "monthly" }))

      expect(res.status).toBe(500)
    })
  })
})
