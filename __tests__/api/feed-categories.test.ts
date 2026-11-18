/**
 * PATCH /api/feeds/[id] — Source categories integration
 *
 * Tests that source PATCH accepts and persists likedCategories / dislikedCategories.
 * Uses existing route, just validates new fields are passed through.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    feed: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/parsers/interest", () => ({
  deleteParallelMonitor: vi.fn(),
  createParallelMonitor: vi.fn(),
  buildWebhookUrl: vi.fn(),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn().mockResolvedValue(null),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { PATCH } from "@/app/api/feeds/[id]/route"

const MOCK_USER_ID = "user-test-123"
const MOCK_SOURCE_ID = "source-test-456"
const params = Promise.resolve({ id: MOCK_SOURCE_ID })

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: MOCK_USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupSource(overrides: Record<string, unknown> = {}) {
  const source = {
    id: MOCK_SOURCE_ID,
    userId: MOCK_USER_ID,
    type: "RSS",
    url: "https://example.com/feed",
    name: "Test Feed",
    isActive: true,
    parallelMonitorId: null,
    interestQuery: null,
    interestCadence: null,
    likedCategories: [],
    dislikedCategories: [],
    ...overrides,
  }
  const sourceRow = source as unknown as Awaited<ReturnType<typeof db.feed.findUnique>>
  vi.mocked(db.feed.findUnique).mockResolvedValue(sourceRow)
  // RAD-323: the write is a compare-and-swap updateMany; count 1 = claim won.
  vi.mocked(db.feed.updateMany).mockResolvedValue({ count: 1 })
  vi.mocked(db.feed.update).mockResolvedValue(sourceRow)
}

beforeEach(() => vi.clearAllMocks())

describe("PATCH /api/feeds/[id] — categories", () => {
  it("passes likedCategories and dislikedCategories to db update", async () => {
    setupAuth()
    setupSource()

    const req = new NextRequest(`http://localhost/api/feeds/${MOCK_SOURCE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        id: MOCK_SOURCE_ID,
        name: "Test Feed",
        type: "RSS",
        url: "https://example.com/feed",
        isActive: true,
        likedCategories: ["Articles", "Tutorials"],
        dislikedCategories: ["Ads"],
      }),
    })

    const res = await PATCH(req, { params })
    expect(res.status).toBe(200)
    expect(db.feed.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          likedCategories: ["Articles", "Tutorials"],
          dislikedCategories: ["Ads"],
        }),
      })
    )
  })

  it("defaults to empty arrays when categories not provided", async () => {
    setupAuth()
    setupSource()

    const req = new NextRequest(`http://localhost/api/feeds/${MOCK_SOURCE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        id: MOCK_SOURCE_ID,
        name: "Test Feed",
        type: "RSS",
        url: "https://example.com/feed",
        isActive: true,
      }),
    })

    const res = await PATCH(req, { params })
    expect(res.status).toBe(200)
    expect(db.feed.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          likedCategories: [],
          dislikedCategories: [],
        }),
      })
    )
  })

  it("returns 409 when the feed changed concurrently (RAD-323 CAS)", async () => {
    setupAuth()
    setupSource()
    // The worker's access reconcile re-armed the feed between our read and write.
    vi.mocked(db.feed.updateMany).mockResolvedValue({ count: 0 })

    const req = new NextRequest(`http://localhost/api/feeds/${MOCK_SOURCE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        id: MOCK_SOURCE_ID,
        name: "Test Feed",
        type: "RSS",
        url: "https://example.com/feed",
        isActive: true,
      }),
    })

    const res = await PATCH(req, { params })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("FEED_CHANGED")
  })
})
