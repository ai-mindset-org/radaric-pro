/**
 * Onboarding Skip — Posts page auto-complete logic
 *
 * Tests that the posts page skips the onboarding redirect when the user already
 * has feeds, and auto-completes onboarding instead.
 *
 * Spec criteria covered:
 *   AC-1: User with feeds + onboardingCompleted=false → no redirect, onboarding auto-completed
 *   AC-2: User with 0 feeds + onboardingCompleted=false → redirect to /onboarding/feeds (preserved)
 *   EC-1: User with feeds but no UserSettings record → auto-creates with onboardingCompleted=true
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks (must precede imports that use them)
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
    userSettings: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    feed: {
      count: vi.fn(),
      // The posts page reads source freshness (RAD-424).
      findMany: vi.fn(),
    },
    material: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

// The posts page opts into the RAD-168 revisit gate, which reads the proxy's
// new-visit request header. No header = a continuing visit, so the gate stays
// out of these cases.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    // Mimic Next.js redirect: throw an object so callers can catch it
    const err = new Error(`NEXT_REDIRECT:${url}`)
    ;(err as Error & { digest: string }).digest = `NEXT_REDIRECT;replace;${url};303;`
    throw err
  }),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"

const USER_ID = "user-onboarding-test"

function setupSession() {
  vi.mocked(auth).mockResolvedValue({
    user: { id: USER_ID, role: "USER" },
  } as never)
  // No complimentary grant by default (paywall reads comp off the User row).
  vi.mocked(db.user.findUnique).mockResolvedValue(null as never)
  // Default: active subscription so the paywall passes
  vi.mocked(db.subscription.findUnique).mockResolvedValue({
    status: "ACTIVE",
    currentPeriodEnd: new Date(Date.now() + 86400 * 1000),
    cancelAtPeriodEnd: false,
  } as never)
}

function setupMaterialCounts(total = 0) {
  vi.mocked(db.feed.findMany).mockResolvedValue([])
  vi.mocked(db.material.findMany).mockResolvedValue([])
  vi.mocked(db.material.count).mockResolvedValue(total)
}

beforeEach(() => {
  vi.clearAllMocks()
  setupMaterialCounts()
})

// ---------------------------------------------------------------------------
// Import the page (after mocks are set up)
// ---------------------------------------------------------------------------
import MaterialsPage from "@/app/(dashboard)/posts/page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Posts page — onboarding skip logic", () => {
  it("AC-1: does not redirect when onboardingCompleted=false and user has 1+ feeds", async () => {
    setupSession()

    // User has incomplete onboarding but already has feeds
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      onboardingCompleted: false,
      onboardingBannerDismissed: true,
    } as never)

    vi.mocked(db.feed.count).mockResolvedValue(2) // has feeds

    // The page should NOT redirect — it should auto-complete onboarding and render
    await expect(MaterialsPage({ searchParams: Promise.resolve({}) })).resolves.not.toThrow()

    // redirect must NOT have been called with the onboarding path
    const redirectCalls = vi.mocked(redirect).mock.calls
    const onboardingRedirects = redirectCalls.filter(([url]) =>
      url.includes("/onboarding")
    )
    expect(onboardingRedirects).toHaveLength(0)
  })

  it("AC-1: auto-completes onboarding (marks onboardingCompleted=true) when user has feeds", async () => {
    setupSession()

    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      onboardingCompleted: false,
      onboardingBannerDismissed: true,
    } as never)

    vi.mocked(db.feed.count).mockResolvedValue(3)

    // Will throw the redirect error or render — either way, check db.userSettings.update was called
    try {
      await MaterialsPage({ searchParams: Promise.resolve({}) })
    } catch {
      // ignore redirect throws
    }

    // Onboarding must have been marked complete via upsert
    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        update: expect.objectContaining({ onboardingCompleted: true }),
        create: expect.objectContaining({ userId: USER_ID, onboardingCompleted: true }),
      })
    )
  })

  it("AC-2: redirects to /onboarding/feeds when onboardingCompleted=false and user has 0 feeds", async () => {
    setupSession()

    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      onboardingCompleted: false,
      onboardingBannerDismissed: false,
    } as never)

    vi.mocked(db.feed.count).mockResolvedValue(0) // no feeds

    await expect(MaterialsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/onboarding/feeds")
  })

  it("COMP: does not redirect to billing when the user has a future complimentary grant and no subscription", async () => {
    setupSession()
    // No paid subscription — access must come from the comp grant alone.
    vi.mocked(db.subscription.findUnique).mockResolvedValue(null)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ onboardingCompleted: true } as never)
    vi.mocked(db.feed.count).mockResolvedValue(2)
    vi.mocked(db.user.findUnique).mockResolvedValue({
      complimentaryAccessUntil: new Date(Date.now() + 30 * 86400 * 1000),
    } as never)

    await expect(MaterialsPage({ searchParams: Promise.resolve({}) })).resolves.not.toThrow()
    const billingRedirects = vi.mocked(redirect).mock.calls.filter(([url]) =>
      url.includes("/settings/billing")
    )
    expect(billingRedirects).toHaveLength(0)
  })

  it("COMP: comp grant survives the auto-complete branch when the user has feeds but no UserSettings row", async () => {
    // The bug this pins: paywall read comp via the userSettings relation, which
    // is null here, so a valid comp user was wrongly bounced to billing while the
    // API gate let them in. Reading comp off the User row directly fixes it.
    setupSession()
    vi.mocked(db.subscription.findUnique).mockResolvedValue(null)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(null) // no settings row
    vi.mocked(db.feed.count).mockResolvedValue(1) // has feeds → auto-complete branch
    vi.mocked(db.userSettings.upsert).mockResolvedValue({ onboardingCompleted: true } as never)
    vi.mocked(db.user.findUnique).mockResolvedValue({
      complimentaryAccessUntil: new Date(Date.now() + 14 * 86400 * 1000),
    } as never)

    try {
      await MaterialsPage({ searchParams: Promise.resolve({}) })
    } catch (err) {
      if ((err as Error)?.message?.includes("NEXT_REDIRECT:/settings/billing")) {
        throw new Error("Comp user wrongly redirected to billing after auto-complete")
      }
    }
    const billingRedirects = vi.mocked(redirect).mock.calls.filter(([url]) =>
      url.includes("/settings/billing")
    )
    expect(billingRedirects).toHaveLength(0)
  })

  it("EC-1: auto-creates UserSettings with onboardingCompleted=true when user has feeds but no settings record", async () => {
    setupSession()

    // No UserSettings record exists
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(null)

    vi.mocked(db.feed.count).mockResolvedValue(1) // has feeds

    vi.mocked(db.userSettings.upsert).mockResolvedValue({
      userId: USER_ID,
      onboardingCompleted: true,
      onboardingBannerDismissed: false,
    } as never)

    // Should not redirect to onboarding
    try {
      await MaterialsPage({ searchParams: Promise.resolve({}) })
    } catch (err) {
      // If it redirects to onboarding, the test fails
      if ((err as Error)?.message?.includes("NEXT_REDIRECT:/onboarding")) {
        throw new Error(
          `EC-1 FAILED: Page redirected to onboarding even though user has feeds and no settings. Got: ${(err as Error).message}`
        )
      }
    }

    // Settings must have been auto-created with onboardingCompleted=true via upsert
    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        update: expect.objectContaining({ onboardingCompleted: true }),
        create: expect.objectContaining({ userId: USER_ID, onboardingCompleted: true }),
      })
    )
  })
})
