/**
 * RAD-212 — /feeds/[id] per-source view (server component)
 *
 * Covers the gating behaviour of app/(dashboard)/feeds/[id]/page.tsx:
 *   - redirects to /signup when not authenticated
 *   - 404s when the feed doesn't exist
 *   - 404s when the feed belongs to a different user
 *   - redirects to /onboarding/feeds when user hasn't onboarded and has zero feeds
 *   - renders successfully for an onboarded user on a feed they own
 *
 * Mirrors __tests__/onboarding-skip.test.ts: imports the page component,
 * stubs auth + db, and calls the async default export directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks (must precede imports that use them)
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    feed: {
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    material: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))

vi.mock("@/lib/entitlements", () => ({
  getTwitterEntitlement: vi.fn(async () => ({ tier: null, includesTwitter: true })),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    ;(err as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};303;`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error("NEXT_NOT_FOUND")
    ;(err as unknown as { digest: string }).digest = "NEXT_NOT_FOUND"
    throw err
  }),
}))

// MaterialsList is a big client component full of hooks; stub it so the server
// page can render during the test without pulling the whole tree.
vi.mock("@/components/materials/materials-list", () => ({
  MaterialsList: () => null,
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { redirect, notFound } from "next/navigation"
import FeedMaterialsPage from "@/app/(dashboard)/feeds/[id]/page"

const USER_ID = "user-rad-212"
const OTHER_USER_ID = "user-other"
const FEED_ID = "feed-abc"

function setSession(userId: string | null) {
  if (userId === null) {
    vi.mocked(auth).mockResolvedValue(null as never)
  } else {
    vi.mocked(auth).mockResolvedValue({
      user: { id: userId, role: "USER" },
    } as never)
  }
}

function setOnboarded() {
  vi.mocked(db.userSettings.findUnique).mockResolvedValue({
    onboardingCompleted: true,
    onboardingBannerDismissed: true,
    notionToken: null,
    notionDatabaseId: null,
  } as never)
}

function setNotOnboardedNoFeeds() {
  vi.mocked(db.userSettings.findUnique).mockResolvedValue({
    onboardingCompleted: false,
    onboardingBannerDismissed: false,
    notionToken: null,
    notionDatabaseId: null,
  } as never)
  vi.mocked(db.feed.count).mockResolvedValue(0)
}

function stubEmptyMaterials() {
  vi.mocked(db.material.findMany).mockResolvedValue([] as never)
  vi.mocked(db.material.count).mockResolvedValue(0)
}

function stubFeedOwned() {
  // First findFirst inside the page itself, second inside fetchMaterialsPage
  vi.mocked(db.feed.findFirst).mockResolvedValue({
    id: FEED_ID,
    name: "The Verge",
    type: "RSS",
    url: "https://rss.theverge.com",
    coverUrl: null,
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("FeedMaterialsPage — auth + onboarding gates", () => {
  it("redirects to /signup when the user is not authenticated", async () => {
    setSession(null)
    await expect(
      FeedMaterialsPage({ params: Promise.resolve({ id: FEED_ID }) })
    ).rejects.toThrow("NEXT_REDIRECT:/signup")
    expect(redirect).toHaveBeenCalledWith("/signup")
  })

  it("redirects to /onboarding/feeds when the user hasn't onboarded and has zero feeds", async () => {
    setSession(USER_ID)
    setNotOnboardedNoFeeds()

    await expect(
      FeedMaterialsPage({ params: Promise.resolve({ id: FEED_ID }) })
    ).rejects.toThrow("NEXT_REDIRECT:/onboarding/feeds")
    expect(redirect).toHaveBeenCalledWith("/onboarding/feeds")
  })
})

describe("FeedMaterialsPage — 404 paths", () => {
  it("calls notFound() when the feed does not exist", async () => {
    setSession(USER_ID)
    setOnboarded()
    stubEmptyMaterials()
    // Feed lookup returns null — feed doesn't exist at all
    vi.mocked(db.feed.findFirst).mockResolvedValue(null)

    await expect(
      FeedMaterialsPage({ params: Promise.resolve({ id: FEED_ID }) })
    ).rejects.toThrow("NEXT_NOT_FOUND")
    expect(notFound).toHaveBeenCalled()
  })

  it("calls notFound() when the feed belongs to another user", async () => {
    setSession(OTHER_USER_ID)
    setOnboarded()
    stubEmptyMaterials()
    // The page scopes the findFirst to { id, userId: OTHER_USER_ID }; feed
    // belongs to USER_ID, so the scoped lookup returns null.
    vi.mocked(db.feed.findFirst).mockResolvedValue(null)

    await expect(
      FeedMaterialsPage({ params: Promise.resolve({ id: FEED_ID }) })
    ).rejects.toThrow("NEXT_NOT_FOUND")
    expect(notFound).toHaveBeenCalled()
    // The feed query must be scoped to the session user
    const call = vi.mocked(db.feed.findFirst).mock.calls[0][0]
    expect(call).toMatchObject({ where: { id: FEED_ID, userId: OTHER_USER_ID } })
  })
})

describe("FeedMaterialsPage — happy path", () => {
  it("renders without throwing for an onboarded user on an owned feed", async () => {
    setSession(USER_ID)
    setOnboarded()
    stubFeedOwned()
    stubEmptyMaterials()

    await expect(
      FeedMaterialsPage({ params: Promise.resolve({ id: FEED_ID }) })
    ).resolves.not.toThrow()

    expect(redirect).not.toHaveBeenCalled()
    expect(notFound).not.toHaveBeenCalled()
  })
})

describe("FeedMaterialsPage — freshness (RAD-424)", () => {
  const feedOfType = (type: string) =>
    vi.mocked(db.feed.findFirst).mockResolvedValue({
      id: FEED_ID,
      name: "A feed",
      type,
      url: "https://example.com",
      coverUrl: null,
      status: "ACTIVE",
      isActive: true,
      lastParsedAt: new Date("2026-11-03T10:00:00Z"),
    } as never)
  const freshnessOf = (el: unknown) => (el as { props: { freshness?: { activeCount: number } } }).props.freshness

  it("shows the feed's freshness", async () => {
    setSession(USER_ID)
    setOnboarded()
    stubEmptyMaterials()
    feedOfType("RSS")
    const el = await FeedMaterialsPage({ params: Promise.resolve({ id: FEED_ID }) })
    expect(freshnessOf(el)?.activeCount).toBe(1)
  })

  it("shows no line for an X feed a Lite user keeps but a parse never reads", async () => {
    setSession(USER_ID)
    setOnboarded()
    stubEmptyMaterials()
    feedOfType("TWITTER")
    vi.mocked(getTwitterEntitlement).mockResolvedValueOnce({ tier: "lite", includesTwitter: false } as never)
    const el = await FeedMaterialsPage({ params: Promise.resolve({ id: FEED_ID }) })
    expect(freshnessOf(el)).toBeUndefined()
  })
})
