// @vitest-environment node

/**
 * RAD-284 — SELF_HOSTED mode.
 *
 * Two gates gate features, and patching one does not reach the other: Twitter
 * is derived by `subscriptionIncludesTwitter` (lib/entitlements.ts), which
 * short-circuits before it ever delegates to `hasActiveAccess`. These tests pin
 * BOTH under the flag, plus the lone-patch failure mode where patching one gate
 * leaves the other enforcing its own rule.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SubscriptionStatus } from "@prisma/client"

// Pin a genuine Lite price id so the "trap" assertion exercises the Lite tier
// rather than the unmapped-id fail-open-to-Pro path.
vi.mock("@/lib/stripe", () => ({
  STRIPE_PRICES: { pro_monthly: "price_pro", pro_yearly: "", lite_monthly: "price_lite", lite_yearly: "" },
  getAppUrl: () => "http://localhost:3000",
}))

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(async () => ({
        id: "u1",
        role: "USER",
        isActive: true,
        // The RAD-297 gate's raw input: unverified.
        emailVerified: null,
        createdAt: new Date(Date.now() - 172_800_000),
        // Comp access so hasActiveAccess passes and the email gate is the only
        // thing denying the user when the flag is off.
        complimentaryAccessUntil: new Date(Date.now() + 86_400_000),
        userSettings: { onboardingCompleted: true },
        subscription: null,
      })),
    },
  },
}))

import { hasActiveAccess, requireActiveSubscription, resolveAccessWithReason, ONBOARDING_DEMO_WINDOW_MS } from "@/lib/subscription"
import { subscriptionIncludesTwitter, getTwitterEntitlement } from "@/lib/entitlements"
import { isSelfHosted } from "@/lib/self-hosted"
import { isEmailVerified, isVerificationEnforced, requireVerifiedEmail } from "@/lib/email-verification"

const NOW = new Date("2026-09-14T12:00:00Z")

function baseInput(over: Record<string, unknown> = {}) {
  return {
    role: "USER",
    onboardingCompleted: true,
    subscription: null,
    complimentaryAccessUntil: null,
    accountCreatedAt: new Date(NOW.getTime() - ONBOARDING_DEMO_WINDOW_MS * 2),
    now: NOW,
    ...over,
  }
}

const LITE_SUB = {
  status: SubscriptionStatus.ACTIVE,
  stripePriceId: "price_lite",
  currentPeriodEnd: new Date(NOW.getTime() + 86_400_000),
  cancelAtPeriodEnd: false,
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("isSelfHosted", () => {
  it("normalizes the value so a stray space or TRUE cannot silently disable the mode", () => {
    expect(isSelfHosted()).toBe(false)
    for (const value of ["1", "true", " true ", "TRUE", "yes", "on"]) {
      vi.stubEnv("SELF_HOSTED", value)
      expect(isSelfHosted(), value).toBe(true)
    }
    for (const value of ["", "0", "false", "no", "off"]) {
      vi.stubEnv("SELF_HOSTED", value)
      expect(isSelfHosted(), value).toBe(false)
    }
  })
})

describe("SELF_HOSTED short-circuits BOTH gates", () => {
  it("hasActiveAccess: a subscription-less USER inside no demo window gets access", () => {
    expect(hasActiveAccess(baseInput() as never)).toBe(false)
    vi.stubEnv("SELF_HOSTED", "true")
    expect(hasActiveAccess(baseInput() as never)).toBe(true)
  })

  it("subscriptionIncludesTwitter: a Lite subscriber gets Twitter (the second gate)", () => {
    expect(subscriptionIncludesTwitter(baseInput({ subscription: LITE_SUB }) as never)).toBe(false)
    vi.stubEnv("SELF_HOSTED", "true")
    expect(subscriptionIncludesTwitter(baseInput({ subscription: LITE_SUB }) as never)).toBe(true)
  })

  it("both gates agree in a single glance — a lone patch fails this test", () => {
    vi.stubEnv("SELF_HOSTED", "true")
    const input = baseInput()
    expect({ access: hasActiveAccess(input as never), twitter: subscriptionIncludesTwitter(input as never) }).toEqual({
      access: true,
      twitter: true,
    })
  })

  it("does not change behaviour when the flag is off", () => {
    expect(hasActiveAccess(baseInput({ role: "ADMIN" }) as never)).toBe(true)
    // demo window: account created a minute ago
    expect(
      hasActiveAccess(baseInput({ onboardingCompleted: false, accountCreatedAt: new Date(NOW.getTime() - 60_000) }) as never)
    ).toBe(true)
    expect(hasActiveAccess(baseInput() as never)).toBe(false)
    expect(subscriptionIncludesTwitter(baseInput({ subscription: LITE_SUB }) as never)).toBe(false)
  })
})

describe("SELF_HOSTED owns the email-verification gate too (RAD-297 x RAD-284)", () => {
  it("an unverified USER passes every verification surface under the flag", async () => {
    // Flag off: the third gate blocks the DB-shaped unverified user.
    expect(await isEmailVerified("u1", "USER")).toBe(false)
    expect((await requireVerifiedEmail("u1", "USER"))?.status).toBe(403)
    expect(await resolveAccessWithReason("u1")).toEqual({ allowed: false, unverified: true })

    vi.stubEnv("SELF_HOSTED", "true")
    // Flag on: self-host has no mail transport by design.
    expect(isVerificationEnforced()).toBe(false)
    expect(await isEmailVerified("u1", "USER")).toBe(true)
    expect(await requireVerifiedEmail("u1", "USER")).toBeNull()
    expect(await resolveAccessWithReason("u1")).toEqual({ allowed: true })
    expect(await requireActiveSubscription("u1", "USER")).toBeNull()
  })

  it("getTwitterEntitlement reports Twitter enabled for a subscription-less USER", async () => {
    vi.stubEnv("SELF_HOSTED", "true")
    expect(await getTwitterEntitlement("u1", "USER")).toEqual({ tier: null, includesTwitter: true })
  })
})
