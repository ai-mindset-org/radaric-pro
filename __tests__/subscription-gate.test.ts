/**
 * hasActiveAccess — TDD RED tests (RAD-148)
 *
 * Pure function that decides whether an authenticated user can access write
 * operations in Radaric. Tests cover the full spec: 10 AC + 3 EC + 2 ERR.
 *
 * Spec criteria: AC-1 through AC-10, EC-1 through EC-3, ERR-1 through ERR-2
 */

import { describe, it, expect } from "vitest"
import { SubscriptionStatus } from "@prisma/client"
import { hasActiveAccess } from "@/lib/subscription"

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-01T12:00:00Z")
const FUTURE = new Date("2026-06-01T00:00:00Z")   // clearly after NOW
const PAST   = new Date("2026-04-01T00:00:00Z")   // clearly before NOW
// RAD-294: the onboarding demo grant is bounded by ONBOARDING_DEMO_WINDOW_MS
// measured from account creation. The default fixture account is 3h old, i.e.
// comfortably inside the window, so the AC-2/COMP-9 cases below still assert
// what they were written to assert. The bound itself is pinned in
// __tests__/paywall-bypass-demo-window.test.ts.
const CREATED_RECENT = new Date("2026-05-01T09:00:00Z")   // NOW - 3h

type SubscriptionShape = {
  status: SubscriptionStatus
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
}

function makeInput(overrides: {
  role?: string
  onboardingCompleted?: boolean
  subscription?: SubscriptionShape | null
  complimentaryAccessUntil?: Date | null
  accountCreatedAt?: Date
  now?: Date
} = {}) {
  return {
    role: "USER" as string,
    onboardingCompleted: true,
    subscription: {
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: FUTURE,
      cancelAtPeriodEnd: false,
    } as SubscriptionShape | null,
    complimentaryAccessUntil: null as Date | null,
    accountCreatedAt: CREATED_RECENT,
    now: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Acceptance Criteria — Happy Path (AC-1 → AC-10)
// ---------------------------------------------------------------------------

describe("hasActiveAccess — Acceptance Criteria", () => {
  it("AC-1: returns true for ADMIN role regardless of subscription state (null sub, onboarding done)", () => {
    const result = hasActiveAccess(makeInput({
      role: "ADMIN",
      onboardingCompleted: true,
      subscription: null,
    }))
    expect(result).toBe(true)
  })

  it("AC-1: returns true for ADMIN role with any subscription status (CANCELED)", () => {
    const result = hasActiveAccess(makeInput({
      role: "ADMIN",
      subscription: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(true)
  })

  it("AC-2: returns true when onboardingCompleted is false regardless of subscription state (null sub)", () => {
    const result = hasActiveAccess(makeInput({
      onboardingCompleted: false,
      subscription: null,
    }))
    expect(result).toBe(true)
  })

  it("AC-2: returns true when onboardingCompleted is false even with expired CANCELED sub", () => {
    const result = hasActiveAccess(makeInput({
      onboardingCompleted: false,
      subscription: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(true)
  })

  it("AC-3: returns true when subscription status is ACTIVE and currentPeriodEnd is in the future", () => {
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(true)
  })

  it("AC-4: returns true when subscription status is TRIALING and currentPeriodEnd is in the future", () => {
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.TRIALING, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(true)
  })

  it("AC-5: returns true when ACTIVE with cancelAtPeriodEnd true and currentPeriodEnd in the future", () => {
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: true },
    }))
    expect(result).toBe(true)
  })

  it("AC-6: returns true when PAST_DUE and currentPeriodEnd is strictly after now (grace window open)", () => {
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.PAST_DUE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(true)
  })

  it("AC-7: returns false when PAST_DUE and currentPeriodEnd is before now (grace window expired)", () => {
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.PAST_DUE, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(false)
  })

  it.each([
    ["CANCELED",           SubscriptionStatus.CANCELED],
    ["UNPAID",             SubscriptionStatus.UNPAID],
    ["INCOMPLETE",         SubscriptionStatus.INCOMPLETE],
    ["INCOMPLETE_EXPIRED", SubscriptionStatus.INCOMPLETE_EXPIRED],
    ["PAUSED",             SubscriptionStatus.PAUSED],
  ])("AC-8: returns false when subscription status is %s", (_label, status) => {
    const result = hasActiveAccess(makeInput({
      subscription: { status, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(false)
  })

  it("AC-9: returns false when subscription is null and onboardingCompleted is true and role is USER", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
    }))
    expect(result).toBe(false)
  })

  it("AC-10: returns false when subscription status is UNKNOWN and role is USER (fail-closed)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      subscription: { status: SubscriptionStatus.UNKNOWN, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edge Cases (EC-1 → EC-3)
// ---------------------------------------------------------------------------

describe("hasActiveAccess — Edge Cases", () => {
  it("EC-1: PAST_DUE with currentPeriodEnd exactly equal to now returns false (strict > contract)", () => {
    const exactNow = new Date("2026-05-01T12:00:00Z")
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.PAST_DUE, currentPeriodEnd: exactNow, cancelAtPeriodEnd: false },
      now: exactNow,
    }))
    expect(result).toBe(false)
  })

  it("EC-2: TRIALING with currentPeriodEnd in the past returns false", () => {
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.TRIALING, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(false)
  })

  it("EC-3: ACTIVE with currentPeriodEnd in the past returns false (defensive against missed webhook)", () => {
    const result = hasActiveAccess(makeInput({
      subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    }))
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error Cases (ERR-1, ERR-2)
// ---------------------------------------------------------------------------

describe("hasActiveAccess — Error Cases", () => {
  it("ERR-1: treats onboardingCompleted undefined as true (fail-closed — blocks access without active sub)", () => {
    const input = makeInput({
      role: "USER",
      subscription: null,
      now: NOW,
    })
    // Simulate undefined being passed (missing field)
    ;(input as never as Record<string, unknown>)["onboardingCompleted"] = undefined
    const result = hasActiveAccess(input as Parameters<typeof hasActiveAccess>[0])
    expect(result).toBe(false)
  })

  it("ERR-2: non-ADMIN role values (empty string) fall through to subscription check — blocks without active sub", () => {
    const result = hasActiveAccess(makeInput({
      role: "",
      onboardingCompleted: true,
      subscription: null,
    }))
    expect(result).toBe(false)
  })

  it("ERR-2: non-ADMIN role value GUEST falls through to subscription check — blocks without active sub", () => {
    const result = hasActiveAccess(makeInput({
      role: "GUEST",
      onboardingCompleted: true,
      subscription: null,
    }))
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Complimentary (time-limited free) access — comp = Lite tier
//
// A hand-granted `complimentaryAccessUntil` future date grants base access
// (write operations) WITHOUT any subscription and WITHOUT Twitter (that Lite
// restriction is enforced in entitlements.ts, tested there). The comp check
// sits AFTER the ADMIN/onboarding bypasses and BEFORE the subscription logic,
// so a comp date rescues a user even when their sub row is null OR lapsed.
// The check is a truthy guard (`until && until > now`) so a missing/undefined
// field can never be mistaken for an active grant.
// ---------------------------------------------------------------------------

describe("hasActiveAccess — Complimentary access", () => {
  it("COMP-1: comp date in the future + no subscription → true (the core grant)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
      complimentaryAccessUntil: FUTURE,
    }))
    expect(result).toBe(true)
  })

  it("COMP-2: comp date in the past + no subscription → false (grant expired, falls through)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
      complimentaryAccessUntil: PAST,
    }))
    expect(result).toBe(false)
  })

  it("COMP-3: comp null + no subscription → false (unchanged baseline behavior)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
      complimentaryAccessUntil: null,
    }))
    expect(result).toBe(false)
  })

  it("COMP-4: comp future rescues a CANCELED/expired subscription (checked before the status gate, sub !== null)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
      complimentaryAccessUntil: FUTURE,
    }))
    expect(result).toBe(true)
  })

  it("COMP-5: comp past + expired sub → false (neither grants)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
      complimentaryAccessUntil: PAST,
    }))
    expect(result).toBe(false)
  })

  it("COMP-6: comp date exactly equal to now → false (strict > contract, mirrors sub grace window)", () => {
    const exactNow = new Date("2026-05-01T12:00:00Z")
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
      complimentaryAccessUntil: exactNow,
      now: exactNow,
    }))
    expect(result).toBe(false)
  })

  it("COMP-7: comp date one ms after now → true (other side of the boundary)", () => {
    const exactNow = new Date("2026-05-01T12:00:00Z")
    const oneMsLater = new Date(exactNow.getTime() + 1)
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
      complimentaryAccessUntil: oneMsLater,
      now: exactNow,
    }))
    expect(result).toBe(true)
  })

  it("COMP-8: ADMIN wins over comp ordering (ADMIN + past comp still true)", () => {
    const result = hasActiveAccess(makeInput({
      role: "ADMIN",
      onboardingCompleted: true,
      subscription: null,
      complimentaryAccessUntil: PAST,
    }))
    expect(result).toBe(true)
  })

  it("COMP-9: onboarding-incomplete wins over comp ordering (incomplete + past comp still true)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: false,
      subscription: null,
      complimentaryAccessUntil: PAST,
    }))
    expect(result).toBe(true)
  })

  it("COMP-10: comp future + active real subscription → true (no conflict, both grant)", () => {
    const result = hasActiveAccess(makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
      complimentaryAccessUntil: FUTURE,
    }))
    expect(result).toBe(true)
  })

  it("COMP-11: undefined comp field is not mistaken for a grant (truthy guard, no active sub → false)", () => {
    const input = makeInput({
      role: "USER",
      onboardingCompleted: true,
      subscription: null,
    })
    // Simulate a mock/DB row that omits the field entirely.
    ;(input as never as Record<string, unknown>)["complimentaryAccessUntil"] = undefined
    const result = hasActiveAccess(input as Parameters<typeof hasActiveAccess>[0])
    expect(result).toBe(false)
  })
})
