/**
 * RAD-345 — `GET /api/stories/[id]` must carry the constituent materials.
 *
 * The side peek renders the same reading body as `/stories/[id]`, so the route
 * has to return what the page selects: materials with their feed and the
 * requesting user's own feedback. Without it the peek could only show a story's
 * headline and summary. Ownership is unchanged — `story.userId` still scopes
 * the read.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures and Prisma include mocks */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: { story: { findUnique: vi.fn() } },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET } from "@/app/api/stories/[id]/route"

const USER_ID = "user-1"

function story(overrides: Record<string, unknown> = {}) {
  return {
    id: "s-1",
    userId: USER_ID,
    title: "A story",
    summary: "Summary",
    body: "Body",
    status: "DRAFT",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    languageFlag: null,
    archiveLinks: null,
    notionPageId: null,
    notionUrl: null,
    keyPoints: [],
    rubrics: [],
    sourceUrls: [],
    inboxItems: [],
    materials: [
      {
        id: "m-1",
        title: "A post",
        url: "https://example.com",
        content: "text",
        contentEntities: null,
        publishedAt: new Date(),
        thumbnailUrl: null,
        mediaUrls: [],
        aiEvaluation: "APPROVED",
        aiConfidence: 80,
        aiReasoning: null,
        userStatus: "NEW",
        createdAt: new Date(),
        feed: { id: "f-1", name: "e/acc", type: "TELEGRAM" },
        feedbacks: [],
      },
    ],
    ...overrides,
  }
}

async function get(id: string) {
  const request = {} as any
  const params = Promise.resolve({ id })
  return GET(request, { params })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(requireAuth as any).mockResolvedValue({ userId: USER_ID })
  ;(isErrorResponse as any).mockReturnValue(false)
  ;(db.story.findUnique as any).mockResolvedValue(story())
})

describe("RAD-345: GET /api/stories/[id]", () => {
  it("selects the materials the peek renders, scoped to the caller's feedback", async () => {
    await get("s-1")

    const args = (db.story.findUnique as any).mock.calls[0][0]
    expect(args.where).toEqual({ id: "s-1" })
    expect(args.include.inboxItems).toBeDefined()
    expect(args.include.materials.orderBy).toEqual({ createdAt: "desc" })
    expect(args.include.materials.select.feed.select).toEqual({ id: true, name: true, type: true })
    expect(args.include.materials.select.feedbacks).toMatchObject({
      where: { userId: USER_ID },
      select: { feedbackType: true },
      take: 1,
    })
  })

  it("returns the story with its materials", async () => {
    const res = await get("s-1")
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.materials).toHaveLength(1)
    expect(body.materials[0].id).toBe("m-1")
  })

  it("404s a story that belongs to another user", async () => {
    ;(db.story.findUnique as any).mockResolvedValue(story({ userId: "other" }))

    const res = await get("s-1")

    expect(res.status).toBe(404)
  })

  it("404s a story that does not exist", async () => {
    ;(db.story.findUnique as any).mockResolvedValue(null)

    const res = await get("s-1")

    expect(res.status).toBe(404)
  })

  it("still answers for a story with no materials (Telegram pipeline)", async () => {
    ;(db.story.findUnique as any).mockResolvedValue(story({ materials: [] }))

    const res = await get("s-1")
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.materials).toEqual([])
  })
})
