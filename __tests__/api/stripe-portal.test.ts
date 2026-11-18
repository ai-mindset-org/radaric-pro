/**
 * POST /api/stripe/portal — Stripe Customer Portal session creation
 *
 * Tests:
 * - AC-1: auth guard
 * - AC-2: user without stripeCustomerId returns 400
 * - AC-3: default flow (no body) creates session with no flow_data
 * - AC-4: flow=switch with active sub creates session with subscription_update flow_data
 * - AC-5: flow=switch but no sub falls back to default portal (no flow_data)
 * - AC-6: invalid body shape returns 400
 * - AC-7: stripe error returns 500
 * RAD-227
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
  },
}))

const stripeBillingPortalSessionsCreate = vi.fn()
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    billingPortal: { sessions: { create: stripeBillingPortalSessionsCreate } },
  }),
  getAppUrl: () => "https://radaric.pro",
}))

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { requireAuth } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { POST } from "@/app/api/stripe/portal/route"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost/api/stripe/portal", {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function makeUser(overrides: {
  stripeCustomerId?: string | null
  subscription?: { stripeSubscriptionId: string } | null
} = {}) {
  return {
    id: "user_123",
    email: "test@example.com",
    role: "USER",
    stripeCustomerId: "stripeCustomerId" in overrides ? overrides.stripeCustomerId : "cus_active",
    subscription: "subscription" in overrides ? overrides.subscription : { stripeSubscriptionId: "sub_active" },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: "user_123", role: "USER" })
  stripeBillingPortalSessionsCreate.mockResolvedValue({
    id: "bps_123",
    url: "https://billing.stripe.com/p/session/test_xyz",
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/stripe/portal", () => {
  // -------------------------------------------------------------------------
  // AC-1: auth guard
  // -------------------------------------------------------------------------
  it("AC-1: when requireAuth returns a Response (unauthenticated), returns that response without touching DB or Stripe", async () => {
    const errorResponse = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    vi.mocked(requireAuth).mockResolvedValue(errorResponse as never)

    const res = await POST(makeRequest())

    expect(res).toBe(errorResponse)
    expect(db.user.findUnique).not.toHaveBeenCalled()
    expect(stripeBillingPortalSessionsCreate).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC-2: no stripeCustomerId
  // -------------------------------------------------------------------------
  it("AC-2: returns 400 when user has no stripeCustomerId", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUser({ stripeCustomerId: null }) as never,
    )

    const res = await POST(makeRequest())

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Subscribe first/i)
    expect(stripeBillingPortalSessionsCreate).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC-3: default flow — no body, no flow_data
  // -------------------------------------------------------------------------
  it("AC-3: creates session WITHOUT flow_data when no body is provided", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)

    const res = await POST(makeRequest())

    expect(res.status).toBe(200)
    expect(stripeBillingPortalSessionsCreate).toHaveBeenCalledTimes(1)
    const params = stripeBillingPortalSessionsCreate.mock.calls[0][0]
    expect(params.customer).toBe("cus_active")
    expect(params.return_url).toBe("https://radaric.pro/settings/billing")
    expect(params.flow_data).toBeUndefined()
  })

  it("AC-3: creates session WITHOUT flow_data when body is empty object", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)

    const res = await POST(makeRequest({}))

    expect(res.status).toBe(200)
    const params = stripeBillingPortalSessionsCreate.mock.calls[0][0]
    expect(params.flow_data).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC-4: flow=switch with active sub
  // -------------------------------------------------------------------------
  it("AC-4: flow=switch with active sub creates session with subscription_update flow_data pointing at the sub id", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUser({
        stripeCustomerId: "cus_switcher",
        subscription: { stripeSubscriptionId: "sub_to_switch" },
      }) as never,
    )

    const res = await POST(makeRequest({ flow: "switch" }))

    expect(res.status).toBe(200)
    const params = stripeBillingPortalSessionsCreate.mock.calls[0][0]
    expect(params.customer).toBe("cus_switcher")
    expect(params.flow_data).toEqual({
      type: "subscription_update",
      subscription_update: {
        subscription: "sub_to_switch",
      },
    })
  })

  // -------------------------------------------------------------------------
  // AC-5: flow=switch but no sub
  // -------------------------------------------------------------------------
  it("AC-5: flow=switch but user has no subscription row falls back to default portal session (no flow_data)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUser({ subscription: null }) as never,
    )

    const res = await POST(makeRequest({ flow: "switch" }))

    expect(res.status).toBe(200)
    const params = stripeBillingPortalSessionsCreate.mock.calls[0][0]
    expect(params.flow_data).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC-6: invalid body shape
  // -------------------------------------------------------------------------
  it("AC-6: invalid flow value returns 400 and never calls Stripe", async () => {
    const res = await POST(makeRequest({ flow: "delete-account" }))

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Invalid body/i)
    expect(stripeBillingPortalSessionsCreate).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC-7: Stripe API error
  // -------------------------------------------------------------------------
  it("AC-7: Stripe error during session create returns 500", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUser() as never)
    stripeBillingPortalSessionsCreate.mockRejectedValue(
      new Error("Stripe portal config missing required feature"),
    )

    const res = await POST(makeRequest({ flow: "switch" }))

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toMatch(/Failed to create portal session/i)
  })
})
