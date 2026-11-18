/**
 * lib/entitlements — Twitter/X tier entitlement derivation.
 *
 * Covers planFromPriceId (incl. empty-string + unknown ids), the
 * subscriptionIncludesTwitter evaluation-order matrix (ADMIN, onboarding demo,
 * Lite veto, Pro grace, unknown-id grandfather, expired/no-sub), and the async
 * getTwitterEntitlement DB-shaped helper.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SubscriptionStatus } from "@prisma/client"

// Deterministic prices so assertions never run against "" (unset env).
vi.mock("@/lib/stripe", () => ({
  STRIPE_PRICES: {
    pro_monthly: "price_pro_m",
    pro_yearly: "price_pro_y",
    lite_monthly: "price_lite_m",
    lite_yearly: "price_lite_y",
  },
}))

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: vi.fn() } },
}))

import {
  planFromPriceId,
  subscriptionIncludesTwitter,
  getTwitterEntitlement,
  type SubscriptionForEntitlement,
} from "@/lib/entitlements"
import { db } from "@/lib/db"

const NOW = new Date("2026-05-01T12:00:00Z")
const FUTURE = new Date("2026-06-01T00:00:00Z")
const PAST = new Date("2026-04-01T00:00:00Z")
// getTwitterEntitlement uses the real `new Date()`, so its fixtures need a
// period end that is in the future relative to the actual test-run clock.
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z")
// RAD-294: the onboarding demo grant is bounded by ONBOARDING_DEMO_WINDOW_MS
// measured from account creation. Default fixture account is 3h old — inside
// the window — so the demo cases below keep asserting what they were written
// to assert. The bound is pinned in __tests__/paywall-bypass-demo-window.test.ts.
const CREATED_RECENT = new Date("2026-05-01T09:00:00Z")   // NOW - 3h

function sub(
  overrides: Partial<SubscriptionForEntitlement> = {}
): SubscriptionForEntitlement {
  return {
    status: SubscriptionStatus.ACTIVE,
    stripePriceId: "price_pro_m",
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    ...overrides,
  }
}

function input(overrides: {
  role?: string
  onboardingCompleted?: boolean | undefined
  subscription?: SubscriptionForEntitlement | null
  accountCreatedAt?: Date
  now?: Date
} = {}) {
  return {
    role: "USER",
    onboardingCompleted: true as boolean | undefined,
    subscription: sub() as SubscriptionForEntitlement | null,
    accountCreatedAt: CREATED_RECENT,
    now: NOW,
    ...overrides,
  }
}

describe("planFromPriceId", () => {
  it("maps each configured price id to its tier + interval", () => {
    expect(planFromPriceId("price_pro_m")).toEqual({ tier: "pro", interval: "monthly" })
    expect(planFromPriceId("price_pro_y")).toEqual({ tier: "pro", interval: "yearly" })
    expect(planFromPriceId("price_lite_m")).toEqual({ tier: "lite", interval: "monthly" })
    expect(planFromPriceId("price_lite_y")).toEqual({ tier: "lite", interval: "yearly" })
  })

  it("returns null for an unknown / legacy id", () => {
    expect(planFromPriceId("price_legacy_unknown")).toBeNull()
  })

  it("returns null for an empty string (never collides with an unset env price)", () => {
    expect(planFromPriceId("")).toBeNull()
  })
})

describe("subscriptionIncludesTwitter — evaluation order", () => {
  it("ADMIN on a Lite price (active) → true", () => {
    expect(
      subscriptionIncludesTwitter(
        input({ role: "ADMIN", subscription: sub({ stripePriceId: "price_lite_m" }) })
      )
    ).toBe(true)
  })

  it("ADMIN with no subscription → true", () => {
    expect(
      subscriptionIncludesTwitter(input({ role: "ADMIN", subscription: null }))
    ).toBe(true)
  })

  it("onboarding user (onboardingCompleted=false, no sub) → true (full-access demo)", () => {
    expect(
      subscriptionIncludesTwitter(
        input({ onboardingCompleted: false, subscription: null })
      )
    ).toBe(true)
  })

  it("Pro ACTIVE in-period → true", () => {
    expect(
      subscriptionIncludesTwitter(input({ subscription: sub({ stripePriceId: "price_pro_m" }) }))
    ).toBe(true)
  })

  it("Lite ACTIVE in-period → false (the Lite restriction)", () => {
    expect(
      subscriptionIncludesTwitter(input({ subscription: sub({ stripePriceId: "price_lite_m" }) }))
    ).toBe(false)
  })

  it("Lite PAST_DUE in grace → false (tier veto beats the grace branch)", () => {
    expect(
      subscriptionIncludesTwitter(
        input({
          subscription: sub({
            stripePriceId: "price_lite_y",
            status: SubscriptionStatus.PAST_DUE,
            currentPeriodEnd: FUTURE,
          }),
        })
      )
    ).toBe(false)
  })

  it("Pro PAST_DUE in grace → true", () => {
    expect(
      subscriptionIncludesTwitter(
        input({
          subscription: sub({
            stripePriceId: "price_pro_m",
            status: SubscriptionStatus.PAST_DUE,
            currentPeriodEnd: FUTURE,
          }),
        })
      )
    ).toBe(true)
  })

  it("unknown / legacy price id on an access-granting sub → true (grandfather to Pro)", () => {
    expect(
      subscriptionIncludesTwitter(
        input({ subscription: sub({ stripePriceId: "price_legacy_unknown" }) })
      )
    ).toBe(true)
  })

  it("no subscription (onboarded USER) → false", () => {
    expect(subscriptionIncludesTwitter(input({ subscription: null }))).toBe(false)
  })

  it("Pro but expired (period in the past) → false (no access at all)", () => {
    expect(
      subscriptionIncludesTwitter(
        input({ subscription: sub({ stripePriceId: "price_pro_m", currentPeriodEnd: PAST }) })
      )
    ).toBe(false)
  })

  it("Lite CANCELED → false", () => {
    expect(
      subscriptionIncludesTwitter(
        input({
          subscription: sub({
            stripePriceId: "price_lite_m",
            status: SubscriptionStatus.CANCELED,
          }),
        })
      )
    ).toBe(false)
  })
})

describe("getTwitterEntitlement", () => {
  beforeEach(() => {
    vi.mocked(db.user.findUnique).mockReset()
  })

  it("ADMIN short-circuits to includesTwitter=true without a tier", async () => {
    const result = await getTwitterEntitlement("u1", "ADMIN")
    expect(result).toEqual({ tier: null, includesTwitter: true })
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  it("Lite subscriber → tier lite, no Twitter", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      userSettings: { onboardingCompleted: true },
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        stripePriceId: "price_lite_m",
        currentPeriodEnd: FAR_FUTURE,
        cancelAtPeriodEnd: false,
      },
    } as never)
    expect(await getTwitterEntitlement("u1", "USER")).toEqual({
      tier: "lite",
      includesTwitter: false,
    })
  })

  it("Pro subscriber → tier pro, Twitter included", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      userSettings: { onboardingCompleted: true },
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        stripePriceId: "price_pro_y",
        currentPeriodEnd: FAR_FUTURE,
        cancelAtPeriodEnd: false,
      },
    } as never)
    expect(await getTwitterEntitlement("u1", "USER")).toEqual({
      tier: "pro",
      includesTwitter: true,
    })
  })

  it("onboarding user (no sub, onboardingCompleted=false) → Twitter included, null tier", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      userSettings: { onboardingCompleted: false },
      subscription: null,
      // RAD-294: freshly created, so inside the bounded demo window.
      createdAt: new Date(),
    } as never)
    expect(await getTwitterEntitlement("u1", "USER")).toEqual({
      tier: null,
      includesTwitter: true,
    })
  })

  it("missing user falls closed (no Twitter, null tier)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(null as never)
    expect(await getTwitterEntitlement("u1", "USER")).toEqual({
      tier: null,
      includesTwitter: false,
    })
  })

  // Comp = Lite: a complimentary-access grant must NEVER unlock Twitter, even
  // when the user also carries a lapsed Pro subscription row. The entitlement is
  // derived from the (real) subscription only; comp influences base access, not
  // this decision. These pin that guarantee so a future refactor can't leak it.
  it("comp-access user with no subscription → no Twitter (comp is Lite, not Pro)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      userSettings: { onboardingCompleted: true },
      subscription: null,
      complimentaryAccessUntil: FAR_FUTURE,
    } as never)
    expect(await getTwitterEntitlement("u1", "USER")).toEqual({
      tier: null,
      includesTwitter: false,
    })
  })

  it("comp-access user WITH a lapsed Pro sub → still no Twitter (leak guard)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      userSettings: { onboardingCompleted: true },
      subscription: {
        status: SubscriptionStatus.CANCELED,
        stripePriceId: "price_pro_m",
        currentPeriodEnd: PAST, // lapsed → grants no access
        cancelAtPeriodEnd: false,
      },
      complimentaryAccessUntil: FAR_FUTURE, // comp keeps them in the app…
    } as never)
    // …but the lapsed Pro sub grants no access, so Twitter stays off.
    expect(await getTwitterEntitlement("u1", "USER")).toEqual({
      tier: "pro",
      includesTwitter: false,
    })
  })
})
