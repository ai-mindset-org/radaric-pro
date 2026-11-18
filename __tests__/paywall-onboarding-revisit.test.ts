/**
 * RAD-168 — the revisit gate inside the dashboard paywall.
 *
 * `requirePaidDashboardAccess({ revisitOnboarding: true })` sends a completed
 * user with zero non-hidden feeds back to onboarding on a new visit. Only the
 * dashboard landing pages (/posts, /feeds) opt in.
 *
 *   AC-1  opted in + completed + paid + new visit + 0 feeds → /onboarding/feeds
 *   AC-2  not opted in → no redirect and no feed count
 *   AC-3  the billing check runs first: unpaid + new visit + 0 feeds → /settings/billing, no feed count
 *   AC-4  incomplete onboarding keeps its own gate and the feed count runs once
 *   AC-5  /posts and /feeds opt in; /feeds/new, /rules, /saved, /saved/[id] do not
 *   AC-6  /posts runs the revisit count once (requireOnboarded adds none for a completed user)
 *   AC-7  requireOnboarded (posts/[id], feeds/[id], folders/[id]) is not gated
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const headerValues = new Map<string, string>()

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (name: string) => headerValues.get(name.toLowerCase()) ?? null })),
}))

vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn() },
    userSettings: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), create: vi.fn() },
    feed: { count: vi.fn(), findMany: vi.fn() },
    material: { findMany: vi.fn(), count: vi.fn() },
    subscription: { findUnique: vi.fn() },
  },
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  getTwitterEntitlement: vi.fn(async () => ({ includesTwitter: true })),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import { requireOnboarded } from "@/lib/materials/fetch-materials-page"
import { NEW_VISIT_HEADER } from "@/lib/visit-marker"

const USER_ID = "user-revisit-paywall"
const ACTIVE_SUB = {
  status: "ACTIVE",
  currentPeriodEnd: new Date(Date.now() + 86400 * 1000),
  cancelAtPeriodEnd: false,
}

function signedIn({ completed = true, subscribed = true } = {}) {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID, role: "USER" } } as never)
  vi.mocked(db.user.findUnique).mockResolvedValue({
    complimentaryAccessUntil: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
  } as never)
  vi.mocked(db.userSettings.findUnique).mockResolvedValue({
    onboardingCompleted: completed,
    onboardingBannerDismissed: true,
    notionToken: null,
    notionDatabaseId: null,
    storyNotionDatabaseId: null,
  } as never)
  vi.mocked(db.subscription.findUnique).mockResolvedValue((subscribed ? ACTIVE_SUB : null) as never)
  vi.mocked(db.material.findMany).mockResolvedValue([])
  vi.mocked(db.material.count).mockResolvedValue(0)
  vi.mocked(db.feed.findMany).mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  headerValues.clear()
})

describe("requirePaidDashboardAccess — RAD-168 revisit gate", () => {
  it("AC-1: opted in, completed, paid, new visit, zero feeds → /onboarding/feeds", async () => {
    signedIn()
    headerValues.set(NEW_VISIT_HEADER, "1")
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(requirePaidDashboardAccess({ revisitOnboarding: true })).rejects.toThrow(/^NEXT_REDIRECT:\/onboarding\/feeds\?revisit=1$/)
  })

  it("AC-1: opted in, continuing visit → passes without counting feeds", async () => {
    signedIn()
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(requirePaidDashboardAccess({ revisitOnboarding: true })).resolves.toEqual({
      userId: USER_ID,
      role: "USER",
    })
    expect(db.feed.count).not.toHaveBeenCalled()
  })

  it("AC-2: not opted in → no redirect and no feed count on a new visit", async () => {
    signedIn()
    headerValues.set(NEW_VISIT_HEADER, "1")
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(requirePaidDashboardAccess()).resolves.toEqual({ userId: USER_ID, role: "USER" })
    expect(db.feed.count).not.toHaveBeenCalled()
  })

  it("AC-3: an unpaid user with zero feeds lands on billing, not onboarding", async () => {
    signedIn({ subscribed: false })
    headerValues.set(NEW_VISIT_HEADER, "1")
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(requirePaidDashboardAccess({ revisitOnboarding: true })).rejects.toThrow(
      "NEXT_REDIRECT:/settings/billing",
    )
    expect(db.feed.count).not.toHaveBeenCalled()
  })

  it("AC-4: incomplete onboarding with feeds latches once and does not count again", async () => {
    signedIn({ completed: false })
    headerValues.set(NEW_VISIT_HEADER, "1")
    vi.mocked(db.feed.count).mockResolvedValue(2)

    await expect(requirePaidDashboardAccess({ revisitOnboarding: true })).resolves.toEqual({
      userId: USER_ID,
      role: "USER",
    })
    expect(db.feed.count).toHaveBeenCalledTimes(1)
    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { onboardingCompleted: true } }),
    )
  })

  it("AC-4: incomplete onboarding with zero feeds keeps its redirect", async () => {
    signedIn({ completed: false })
    vi.mocked(db.feed.count).mockResolvedValue(0)

    // A first-time user gets the plain URL, so the first-time copy.
    await expect(requirePaidDashboardAccess()).rejects.toThrow(/^NEXT_REDIRECT:\/onboarding\/feeds$/)
    expect(db.feed.count).toHaveBeenCalledTimes(1)
  })
})

describe("RAD-168 — which pages opt in", () => {
  // Every page calls the paywall first; a new visit with zero feeds is the case
  // that separates an opted-in page (redirect) from one that is not.
  function zeroFeedsNewVisit() {
    signedIn()
    headerValues.set(NEW_VISIT_HEADER, "1")
    vi.mocked(db.feed.count).mockResolvedValue(0)
  }

  it("AC-5: /posts opts in", async () => {
    zeroFeedsNewVisit()
    const { default: PostsPage } = await import("@/app/(dashboard)/posts/page")

    await expect(PostsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/^NEXT_REDIRECT:\/onboarding\/feeds\?revisit=1$/)
  })

  it("AC-5: /feeds opts in", async () => {
    zeroFeedsNewVisit()
    const { default: FeedsPage } = await import("@/app/(dashboard)/feeds/page")

    await expect(FeedsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/onboarding\/feeds\?revisit=1$/)
  })

  it.each([
    ["/feeds/new", () => import("@/app/(dashboard)/feeds/new/page")],
    ["/rules", () => import("@/app/(dashboard)/rules/page")],
    ["/saved", () => import("@/app/(dashboard)/saved/page")],
    ["/saved/[collectionId]", () => import("@/app/(dashboard)/saved/[collectionId]/page")],
  ])("AC-5: %s does not opt in", async (_route, load) => {
    zeroFeedsNewVisit()
    const page = (await load()).default as (props: unknown) => Promise<unknown>

    // Past the paywall the page body may fail on queries this file does not
    // mock; only the gate matters here, so the outcome of the render is ignored.
    await page({ params: Promise.resolve({ collectionId: "c1" }) }).catch(() => {})
    expect(auth).toHaveBeenCalled()
    expect(db.subscription.findUnique).toHaveBeenCalled()
    expect(headers).not.toHaveBeenCalled()
    const onboardingRedirects = vi.mocked(redirect).mock.calls.filter(([url]) => url.includes("/onboarding"))
    expect(onboardingRedirects).toHaveLength(0)
  })

  it("AC-6: /posts on a new visit with feeds counts them once", async () => {
    signedIn()
    headerValues.set(NEW_VISIT_HEADER, "1")
    vi.mocked(db.feed.count).mockResolvedValue(3)
    const { default: PostsPage } = await import("@/app/(dashboard)/posts/page")

    await PostsPage({ searchParams: Promise.resolve({}) })
    expect(db.feed.count).toHaveBeenCalledTimes(1)
  })

  it("AC-7: requireOnboarded does not gate a completed user on a new visit", async () => {
    signedIn()
    headerValues.set(NEW_VISIT_HEADER, "1")
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(requireOnboarded(USER_ID)).resolves.toMatchObject({ onboardingCompleted: true })
    expect(db.feed.count).not.toHaveBeenCalled()
  })
})
