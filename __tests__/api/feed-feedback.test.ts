/**
 * GET/DELETE /api/feeds/[id]/feedback — Source feedback management
 *
 * Tests for:
 *   - GET: list feedback with stats (likes, dislikes count)
 *   - DELETE: bulk reset all feedback for a source
 *   - Auth + ownership checks
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    feed: { findUnique: vi.fn() },
    aIFeedback: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn().mockResolvedValue(null),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET, DELETE } from "@/app/api/feeds/[id]/feedback/route"

const MOCK_USER_ID = "user-test-123"
const MOCK_SOURCE_ID = "source-test-456"
const params = Promise.resolve({ id: MOCK_SOURCE_ID })

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: MOCK_USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupSource() {
  vi.mocked(db.feed.findUnique).mockResolvedValue({
    id: MOCK_SOURCE_ID,
    userId: MOCK_USER_ID,
  } as any)
}

beforeEach(() => vi.clearAllMocks())

describe("GET /api/feeds/[id]/feedback", () => {
  it("returns feedback list with stats", async () => {
    setupAuth()
    setupSource()
    vi.mocked(db.aIFeedback.findMany).mockResolvedValue([
      { id: "f1", feedbackType: "LIKE", commentText: "Good", materialId: "m1", createdAt: new Date() },
      { id: "f2", feedbackType: "DISLIKE", commentText: null, materialId: "m2", createdAt: new Date() },
    ] as any)
    vi.mocked(db.aIFeedback.groupBy).mockResolvedValue([
      { feedbackType: "LIKE", _count: 1 },
      { feedbackType: "DISLIKE", _count: 1 },
    ] as any)

    const req = new NextRequest(`http://localhost/api/feeds/${MOCK_SOURCE_ID}/feedback`)
    const res = await GET(req, { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.feedbacks).toHaveLength(2)
    expect(data.stats.likes).toBe(1)
    expect(data.stats.dislikes).toBe(1)
  })

  it("returns 404 for non-owned source", async () => {
    setupAuth()
    vi.mocked(db.feed.findUnique).mockResolvedValue(null)

    const req = new NextRequest(`http://localhost/api/feeds/${MOCK_SOURCE_ID}/feedback`)
    const res = await GET(req, { params })

    expect(res.status).toBe(404)
  })
})

describe("DELETE /api/feeds/[id]/feedback", () => {
  it("deletes all feedback for a source", async () => {
    setupAuth()
    setupSource()
    vi.mocked(db.aIFeedback.deleteMany).mockResolvedValue({ count: 5 } as any)

    const req = new NextRequest(`http://localhost/api/feeds/${MOCK_SOURCE_ID}/feedback`, { method: "DELETE" })
    const res = await DELETE(req, { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.deleted).toBe(5)
    expect(db.aIFeedback.deleteMany).toHaveBeenCalledWith({
      where: { sourceId: MOCK_SOURCE_ID, userId: MOCK_USER_ID },
    })
  })
})
