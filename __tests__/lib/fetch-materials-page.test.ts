/**
 * RAD-208 — fetchMaterialsPage + requireOnboarded helpers
 *
 * Unit tests for the shared helpers extracted from /posts/page.tsx. Covers:
 *   - requireOnboarded: onboarded path, redirect path, auto-complete path, missing-record path
 *   - fetchMaterialsPage: /posts mode (with sourceType counts), per-source mode (without),
 *     ownership error, pagination, baseWhere shape
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    feed: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    material: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    ;(err as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};303;`
    throw err
  }),
}))

import { db } from "@/lib/db"
import { redirect } from "next/navigation"
import {
  fetchMaterialsPage,
  requireOnboarded,
  FeedNotFoundOrForbiddenError,
} from "@/lib/materials/fetch-materials-page"

const USER_ID = "user-rad-208"
const OTHER_USER_ID = "user-other"
const FEED_ID = "feed-abc"

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// requireOnboarded
// ---------------------------------------------------------------------------

describe("requireOnboarded", () => {
  it("returns existing settings when onboardingCompleted is true", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      onboardingCompleted: true,
      onboardingBannerDismissed: true,
      notionToken: "tok",
      notionDatabaseId: "db",
    } as never)

    const result = await requireOnboarded(USER_ID)

    expect(result).toEqual({
      onboardingCompleted: true,
      onboardingBannerDismissed: true,
      notionToken: "tok",
      notionDatabaseId: "db",
    })
    expect(redirect).not.toHaveBeenCalled()
    expect(db.userSettings.upsert).not.toHaveBeenCalled()
    expect(db.feed.count).not.toHaveBeenCalled()
  })

  it("redirects to /onboarding/feeds when not onboarded and user has zero feeds", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      onboardingCompleted: false,
      onboardingBannerDismissed: false,
      notionToken: null,
      notionDatabaseId: null,
    } as never)
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(requireOnboarded(USER_ID)).rejects.toThrow(
      "NEXT_REDIRECT:/onboarding/feeds"
    )
    expect(redirect).toHaveBeenCalledWith("/onboarding/feeds")
    expect(db.userSettings.upsert).not.toHaveBeenCalled()
  })

  it("auto-completes onboarding when not onboarded but user has feeds", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({
      onboardingCompleted: false,
      onboardingBannerDismissed: true,
      notionToken: "existing-tok",
      notionDatabaseId: "existing-db",
    } as never)
    vi.mocked(db.feed.count).mockResolvedValue(3)
    vi.mocked(db.userSettings.upsert).mockResolvedValue({} as never)

    const result = await requireOnboarded(USER_ID)

    expect(redirect).not.toHaveBeenCalled()
    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        update: expect.objectContaining({ onboardingCompleted: true }),
        create: expect.objectContaining({ userId: USER_ID, onboardingCompleted: true }),
      })
    )
    expect(result.onboardingCompleted).toBe(true)
    expect(result.onboardingBannerDismissed).toBe(true)
    expect(result.notionToken).toBe("existing-tok")
    expect(result.notionDatabaseId).toBe("existing-db")
  })

  it("synthesizes defaults when UserSettings record doesn't exist yet and user has feeds", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(null)
    vi.mocked(db.feed.count).mockResolvedValue(1)
    vi.mocked(db.userSettings.upsert).mockResolvedValue({} as never)

    const result = await requireOnboarded(USER_ID)

    expect(redirect).not.toHaveBeenCalled()
    expect(db.userSettings.upsert).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      onboardingCompleted: true,
      onboardingBannerDismissed: false,
      notionToken: null,
      notionDatabaseId: null,
      // RAD-345 — the story peek needs the story database flag, and it comes
      // from the same single settings read.
      storyNotionDatabaseId: null,
    })
  })
})

// ---------------------------------------------------------------------------
// fetchMaterialsPage — /posts mode (no feedId)
// ---------------------------------------------------------------------------

describe("fetchMaterialsPage — /posts mode", () => {
  function setupCountReturns(values: {
    total: number
    approved: number
    filtered: number
    sent: number
    archived: number
    rss: number
    tg: number
    tw: number
    yt: number
    et: number
  }) {
    // The helper makes 10 material.count calls in /posts mode (order matters):
    //   total, approved, filtered, sent, archived, rss, tg, tw, youtube, event-trigger
    vi.mocked(db.material.count)
      .mockResolvedValueOnce(values.total)
      .mockResolvedValueOnce(values.approved)
      .mockResolvedValueOnce(values.filtered)
      .mockResolvedValueOnce(values.sent)
      .mockResolvedValueOnce(values.archived)
      .mockResolvedValueOnce(values.rss)
      .mockResolvedValueOnce(values.tg)
      .mockResolvedValueOnce(values.tw)
      .mockResolvedValueOnce(values.yt)
      .mockResolvedValueOnce(values.et)
  }

  it("returns materials, total, and full serverCounts including sourceType breakdown", async () => {
    vi.mocked(db.material.findMany).mockResolvedValue([
      { id: "m1" },
      { id: "m2" },
    ] as never)
    setupCountReturns({
      total: 100,
      approved: 60,
      filtered: 30,
      sent: 5,
      archived: 5,
      rss: 40,
      tg: 25,
      tw: 20,
      yt: 5,
      et: 10,
    })

    const result = await fetchMaterialsPage({ userId: USER_ID })

    expect(result.total).toBe(100)
    expect(result.materials).toHaveLength(2)
    expect(result.serverCounts.filter).toEqual({
      INBOX: 60,
      APPROVED: 60,
      FILTERED: 30,
      SENT_TO_NOTION: 5,
      ARCHIVED: 5,
      ALL: 100,
    })
    expect(result.serverCounts.sourceType).toEqual({
      ALL: 100,
      RSS: 40,
      TELEGRAM: 25,
      TWITTER: 20,
      YOUTUBE: 5,
      EVENT_TRIGGER: 10,
    })
  })

  it("does NOT perform a feed ownership check when feedId is omitted", async () => {
    vi.mocked(db.material.findMany).mockResolvedValue([] as never)
    setupCountReturns({ total: 0, approved: 0, filtered: 0, sent: 0, archived: 0, rss: 0, tg: 0, tw: 0, yt: 0, et: 0 })

    await fetchMaterialsPage({ userId: USER_ID })

    expect(db.feed.findFirst).not.toHaveBeenCalled()
  })

  it("uses the default pageSize of 96 when not specified", async () => {
    vi.mocked(db.material.findMany).mockResolvedValue([] as never)
    setupCountReturns({ total: 0, approved: 0, filtered: 0, sent: 0, archived: 0, rss: 0, tg: 0, tw: 0, yt: 0, et: 0 })

    await fetchMaterialsPage({ userId: USER_ID })

    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 96 })
    )
  })

  it("honors a custom pageSize", async () => {
    vi.mocked(db.material.findMany).mockResolvedValue([] as never)
    setupCountReturns({ total: 0, approved: 0, filtered: 0, sent: 0, archived: 0, rss: 0, tg: 0, tw: 0, yt: 0, et: 0 })

    await fetchMaterialsPage({ userId: USER_ID, pageSize: 25 })

    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25 })
    )
  })
})

// ---------------------------------------------------------------------------
// fetchMaterialsPage — per-source mode (feedId)
// ---------------------------------------------------------------------------

describe("fetchMaterialsPage — per-source mode", () => {
  function setupFeedOwnership(owned: boolean) {
    vi.mocked(db.feed.findFirst).mockResolvedValue(
      owned ? ({ id: FEED_ID } as never) : null
    )
  }

  function setupPerSourceCounts(values: {
    total: number
    approved: number
    filtered: number
    sent: number
    archived: number
  }) {
    // Per-source mode makes 6 material.count calls (no sourceType breakdown):
    //   total, approved, filtered, sent, archived
    vi.mocked(db.material.count)
      .mockResolvedValueOnce(values.total)
      .mockResolvedValueOnce(values.approved)
      .mockResolvedValueOnce(values.filtered)
      .mockResolvedValueOnce(values.sent)
      .mockResolvedValueOnce(values.archived)
  }

  it("verifies feed ownership via db.feed.findFirst before fetching", async () => {
    setupFeedOwnership(true)
    vi.mocked(db.material.findMany).mockResolvedValue([] as never)
    setupPerSourceCounts({ total: 0, approved: 0, filtered: 0, sent: 0, archived: 0 })

    await fetchMaterialsPage({ userId: USER_ID, feedId: FEED_ID })

    expect(db.feed.findFirst).toHaveBeenCalledWith({
      where: { id: FEED_ID, userId: USER_ID },
      select: { id: true },
    })
  })

  it("throws FeedNotFoundOrForbiddenError when the feed doesn't belong to the user", async () => {
    setupFeedOwnership(false)

    await expect(
      fetchMaterialsPage({ userId: OTHER_USER_ID, feedId: FEED_ID })
    ).rejects.toBeInstanceOf(FeedNotFoundOrForbiddenError)

    expect(db.material.findMany).not.toHaveBeenCalled()
    expect(db.material.count).not.toHaveBeenCalled()
  })

  it("returns filter counts but OMITS sourceType when feedId is provided", async () => {
    setupFeedOwnership(true)
    vi.mocked(db.material.findMany).mockResolvedValue([{ id: "m1" }] as never)
    setupPerSourceCounts({ total: 42, approved: 30, filtered: 10, sent: 1, archived: 1 })

    const result = await fetchMaterialsPage({ userId: USER_ID, feedId: FEED_ID })

    expect(result.total).toBe(42)
    expect(result.serverCounts.filter).toEqual({
      INBOX: 30,
      APPROVED: 30,
      FILTERED: 10,
      SENT_TO_NOTION: 1,
      ARCHIVED: 1,
      ALL: 42,
    })
    expect(result.serverCounts.sourceType).toBeUndefined()
  })

  it("scopes findMany to the feed via the where clause", async () => {
    setupFeedOwnership(true)
    vi.mocked(db.material.findMany).mockResolvedValue([] as never)
    setupPerSourceCounts({ total: 0, approved: 0, filtered: 0, sent: 0, archived: 0 })

    await fetchMaterialsPage({ userId: USER_ID, feedId: FEED_ID })

    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          feed: { userId: USER_ID, id: FEED_ID },
        }),
      })
    )
  })
})
