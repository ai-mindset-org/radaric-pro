/**
 * RAD-294 — paywall bypass via unbounded onboarding demo grant.
 *
 * lib/subscription.ts:22 and lib/entitlements.ts:59 both grant full access
 * whenever `onboardingCompleted === false`, with no time bound. That grant is
 * both resettable (V1 — see __tests__/api/user-settings-paywall-bypass.test.ts)
 * and, for a user who simply never completes onboarding, permanent (V2 —
 * covered here).
 *
 * The fix threads a demo-window bound derived from `User.createdAt` into both
 * pure functions as a REQUIRED input field (lib/subscription.ts:15-16 already
 * documents this convention: required fields force tsc to enumerate every call
 * site). The window is 24 hours — long enough to try the product, short enough
 * that a genuine onboarding session never brushes the limit.
 *
 * The window length is imported, not re-declared, so these cases stay bound to
 * the shipped constant if it is ever retuned. Inputs are passed uncast for the
 * same reason: a future signature change must break this file loudly.
 */

import { describe, it, expect } from "vitest"
import { SubscriptionStatus } from "@prisma/client"
import { hasActiveAccess, ONBOARDING_DEMO_WINDOW_MS } from "@/lib/subscription"
import { subscriptionIncludesTwitter } from "@/lib/entitlements"

const NOW = new Date("2026-05-01T12:00:00Z")

// Signed up 10 windows ago and never completed onboarding — the V2 exploit:
// call APIs directly, forever, without ever loading a dashboard page that would
// auto-complete onboarding (lib/paywall.ts:41-50).
const STALE_SIGNUP = new Date(NOW.getTime() - 10 * ONBOARDING_DEMO_WINDOW_MS)

// Signed up 5 minutes ago — inside the demo window, must keep working.
const FRESH_SIGNUP = new Date(NOW.getTime() - 5 * 60 * 1000)

// The last instant that still counts as inside the window, and the first that
// does not — pins the boundary itself, not just a point either side of it.
const AT_WINDOW_EDGE = new Date(NOW.getTime() - (ONBOARDING_DEMO_WINDOW_MS - 1))
const JUST_PAST_EDGE = new Date(NOW.getTime() - ONBOARDING_DEMO_WINDOW_MS)

function baseSubscriptionInput(overrides: {
  onboardingCompleted?: boolean | undefined
  accountCreatedAt?: Date
  role?: string
} = {}) {
  return {
    role: overrides.role ?? "USER",
    onboardingCompleted: overrides.onboardingCompleted ?? false,
    subscription: null,
    complimentaryAccessUntil: null,
    accountCreatedAt: overrides.accountCreatedAt ?? STALE_SIGNUP,
    now: NOW,
  }
}

function baseEntitlementInput(overrides: {
  onboardingCompleted?: boolean | undefined
  accountCreatedAt?: Date
  role?: string
} = {}) {
  return {
    role: overrides.role ?? "USER",
    onboardingCompleted: overrides.onboardingCompleted ?? false,
    subscription: null,
    accountCreatedAt: overrides.accountCreatedAt ?? STALE_SIGNUP,
    now: NOW,
  }
}

describe("hasActiveAccess — RAD-294 V2: unbounded onboarding demo grant", () => {
  it("V2: onboardingCompleted=false + account far older than the demo window → access DENIED", () => {
    const result = hasActiveAccess(baseSubscriptionInput({
      onboardingCompleted: false,
      accountCreatedAt: STALE_SIGNUP,
    }))

    // Currently hasActiveAccess unconditionally returns true at line 22 for
    // onboardingCompleted===false, regardless of account age. This must fail
    // today: a 10-day-old account with incomplete onboarding gets `true`.
    expect(result).toBe(false)
  })

  it("demo still works: onboardingCompleted=false + account created moments ago → access GRANTED", () => {
    const result = hasActiveAccess(baseSubscriptionInput({
      onboardingCompleted: false,
      accountCreatedAt: FRESH_SIGNUP,
    }))

    expect(result).toBe(true)
  })

  it("boundary: 1ms inside the window → GRANTED; exactly at the window → DENIED", () => {
    expect(hasActiveAccess(baseSubscriptionInput({
      accountCreatedAt: AT_WINDOW_EDGE,
    }))).toBe(true)

    expect(hasActiveAccess(baseSubscriptionInput({
      accountCreatedAt: JUST_PAST_EDGE,
    }))).toBe(false)
  })
})

describe("subscriptionIncludesTwitter — RAD-294 V2: unbounded onboarding demo grant", () => {
  it("V2: onboardingCompleted=false + account far older than the demo window → Twitter DENIED", () => {
    // subscriptionIncludesTwitter short-circuits at lib/entitlements.ts:59
    // BEFORE it ever delegates to hasActiveAccess, so this needs its own case —
    // fixing hasActiveAccess alone would not fix this path.
    const result = subscriptionIncludesTwitter(baseEntitlementInput({
      onboardingCompleted: false,
      accountCreatedAt: STALE_SIGNUP,
    }))

    expect(result).toBe(false)
  })

  it("demo still works: onboardingCompleted=false + account created moments ago → Twitter GRANTED", () => {
    const result = subscriptionIncludesTwitter(baseEntitlementInput({
      onboardingCompleted: false,
      accountCreatedAt: FRESH_SIGNUP,
    }))

    expect(result).toBe(true)
  })

  it("boundary: 1ms inside the window → GRANTED; exactly at the window → DENIED", () => {
    expect(subscriptionIncludesTwitter(baseEntitlementInput({
      accountCreatedAt: AT_WINDOW_EDGE,
    }))).toBe(true)

    expect(subscriptionIncludesTwitter(baseEntitlementInput({
      accountCreatedAt: JUST_PAST_EDGE,
    }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Non-regression set (5-8) — must pass BOTH before and after the fix. These
// pin behaviour the fix must not disturb while it closes V1/V2.
// ---------------------------------------------------------------------------

describe("hasActiveAccess — RAD-294 non-regression", () => {
  it("(5) ADMIN has access regardless of onboarding state or account age", () => {
    const result = hasActiveAccess({
      role: "ADMIN",
      onboardingCompleted: false,
      subscription: null,
      complimentaryAccessUntil: null,
      accountCreatedAt: STALE_SIGNUP,
      now: NOW,
    })

    expect(result).toBe(true)
  })

  it("(6) ACTIVE subscription with currentPeriodEnd in the future has access, regardless of onboarding state or account age", () => {
    const result = hasActiveAccess({
      role: "USER",
      onboardingCompleted: false,
      subscription: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
      },
      complimentaryAccessUntil: null,
      accountCreatedAt: STALE_SIGNUP,
      now: NOW,
    })

    expect(result).toBe(true)
  })

  it("(7a) complimentaryAccessUntil in the future has access", () => {
    const result = hasActiveAccess({
      role: "USER",
      onboardingCompleted: false,
      subscription: null,
      complimentaryAccessUntil: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
      accountCreatedAt: STALE_SIGNUP,
      now: NOW,
    })

    expect(result).toBe(true)
  })
})

describe("subscriptionIncludesTwitter — RAD-294 non-regression", () => {
  it("(7b) comp access must still NOT grant Twitter (lib/entitlements.ts:73-76)", () => {
    // subscriptionIncludesTwitter never receives complimentaryAccessUntil at
    // all (it is deliberately passed as null to hasActiveAccess internally),
    // so a comp-access user with no subscription and completed onboarding
    // must resolve to false here.
    const result = subscriptionIncludesTwitter({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
      accountCreatedAt: STALE_SIGNUP,
      now: NOW,
    })

    expect(result).toBe(false)
  })
})
