/**
 * stripe-customer (RAD-148) — RAD-223 hardening: email-search dropped.
 *
 * Originally `getOrCreateStripeCustomer` searched Stripe by email before
 * creating, intending to recover orphaned customers when the DB→Stripe link
 * was lost. RAD-223 (B1) drops the search because it cross-matches across
 * user accounts: if the same email is reused (account deleted then
 * re-registered, or two unrelated users with the same email), the new
 * userId silently inherits the old customer's payment methods, billing
 * history, and active subscriptions. The DB `User.stripeCustomerId` column
 * is the canonical link; `metadata.userId` on the Stripe customer is the
 * audit trail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const stripeMock = {
  customers: {
    list: vi.fn(),
    create: vi.fn(),
  },
}

vi.mock("@/lib/stripe", () => ({
  getStripe: () => stripeMock,
}))

const stripe = stripeMock
import { getOrCreateStripeCustomer } from "@/lib/stripe-customer"

function makeInput(overrides: Partial<{
  userId: string
  email: string
  existingStripeCustomerId: string | null
}> = {}) {
  return {
    userId: "user_abc",
    email: "test@example.com",
    existingStripeCustomerId: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getOrCreateStripeCustomer", () => {
  it("AC-1: returns existing customer id immediately when provided, without calling list or create", async () => {
    const result = await getOrCreateStripeCustomer(
      makeInput({ existingStripeCustomerId: "cus_already_known" })
    )

    expect(result).toBe("cus_already_known")
    expect(stripe.customers.list).toHaveBeenCalledTimes(0)
    expect(stripe.customers.create).toHaveBeenCalledTimes(0)
  })

  it("AC-2 (RAD-223): when existingStripeCustomerId is null, creates a new customer directly — never searches by email", async () => {
    vi.mocked(stripe.customers.create).mockResolvedValue({ id: "cus_new_456" } as never)

    const result = await getOrCreateStripeCustomer(
      makeInput({ userId: "user_abc", email: "test@example.com" })
    )

    expect(result).toBe("cus_new_456")
    expect(stripe.customers.list).toHaveBeenCalledTimes(0)
    expect(stripe.customers.create).toHaveBeenCalledTimes(1)
    expect(stripe.customers.create).toHaveBeenCalledWith({
      email: "test@example.com",
      metadata: { userId: "user_abc" },
    })
  })

  it("AC-3 (RAD-223): does NOT cross-match an existing Stripe customer when the same email belongs to a different userId", async () => {
    // Even if a Stripe customer with the same email already exists from a
    // previous account, the new userId must get a fresh customer record so
    // payment methods, subscriptions, and billing history don't bleed across
    // unrelated accounts.
    vi.mocked(stripe.customers.create).mockResolvedValue({ id: "cus_fresh_for_user_b" } as never)

    const result = await getOrCreateStripeCustomer(
      makeInput({ userId: "user_b", email: "shared@example.com" })
    )

    expect(result).toBe("cus_fresh_for_user_b")
    expect(stripe.customers.list).toHaveBeenCalledTimes(0)
    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { userId: "user_b" } })
    )
  })

  it("AC-4: customers.create call includes metadata with the correct userId", async () => {
    vi.mocked(stripe.customers.create).mockResolvedValue({ id: "cus_meta_789" } as never)

    await getOrCreateStripeCustomer(
      makeInput({ userId: "user_specific_id", email: "meta@example.com" })
    )

    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { userId: "user_specific_id" } })
    )
  })

  it("EC-1: when stripe.customers.create throws, the error propagates", async () => {
    vi.mocked(stripe.customers.create).mockRejectedValue(new Error("Create failed"))

    await expect(getOrCreateStripeCustomer(makeInput())).rejects.toThrow("Create failed")
  })
})
