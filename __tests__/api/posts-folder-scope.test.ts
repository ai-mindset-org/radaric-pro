/**
 * RAD-393 — GET /api/posts folder scope.
 *
 * The folder predicate must be `{ userId, folderId, hidden: false, isActive:
 * true }` — the visible sidebar tree — and it must combine with the search
 * `AND` branch, the filter presets and the source-type filter without dropping
 * the scope. A foreign or empty folder yields an empty page, never account-wide
 * rows (userId stays in every branch).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma where-builder mocks */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    material: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET } from "@/app/api/posts/route"

const USER_ID = "user-rad-393"
const FOLDER_ID = "folder-1"
const FEED_ID = "feed-1"

function request(query: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/posts")
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return { nextUrl: url } as unknown as NextRequest
}

function lastWhere(): any {
  return vi.mocked(db.material.findMany).mock.calls[0][0]?.where
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" } as never)
  vi.mocked(isErrorResponse).mockReturnValue(false)
  vi.mocked(db.material.findMany).mockResolvedValue([] as never)
  vi.mocked(db.material.count).mockResolvedValue(0 as never)
})

describe("GET /api/posts — folder scope", () => {
  it("scopes to the folder's visible, active members and sets no sourceId", async () => {
    await GET(request({ folderId: FOLDER_ID }))

    const where = lastWhere()
    expect(where.feed).toEqual({
      userId: USER_ID,
      folderId: FOLDER_ID,
      hidden: false,
      isActive: true,
    })
    expect(where.sourceId).toBeUndefined()
  })

  it("keeps the folder scope through the search AND branch", async () => {
    await GET(request({ folderId: FOLDER_ID, search: "design" }))

    const where = lastWhere()
    expect(where.AND[0].feed).toEqual({
      userId: USER_ID,
      folderId: FOLDER_ID,
      hidden: false,
      isActive: true,
    })
    expect(where.feed).toEqual({
      userId: USER_ID,
      folderId: FOLDER_ID,
      hidden: false,
      isActive: true,
    })
  })

  it("keeps the folder scope when a source type is filtered", async () => {
    await GET(request({ folderId: FOLDER_ID, sourceType: "RSS" }))

    const where = lastWhere()
    expect(where.feed).toEqual({
      userId: USER_ID,
      folderId: FOLDER_ID,
      hidden: false,
      isActive: true,
      type: { in: ["RSS"] },
    })
  })

  it("applies the view preset inside the folder scope", async () => {
    await GET(request({ folderId: FOLDER_ID, filter: "INBOX" }))

    const where = lastWhere()
    expect(where.aiEvaluation).toBe("APPROVED")
    expect(where.userStatus).toEqual({ notIn: ["DELETED", "ARCHIVED"] })
    expect(where.feed.folderId).toBe(FOLDER_ID)
  })

  it("intersects both scopes when sourceId and folderId are passed together", async () => {
    await GET(request({ sourceId: FEED_ID, folderId: FOLDER_ID }))

    const where = lastWhere()
    expect(where.feed).toEqual({
      userId: USER_ID,
      id: FEED_ID,
      folderId: FOLDER_ID,
      hidden: false,
      isActive: true,
    })
    expect(where.sourceId).toBe(FEED_ID)
  })

  it("does not filter folder scope for an account-wide read", async () => {
    await GET(request({}))

    expect(lastWhere().feed).toEqual({ userId: USER_ID, hidden: false })
  })
})
