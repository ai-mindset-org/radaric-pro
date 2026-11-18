/**
 * RAD-343 — GET /api/posts/counts.
 *
 * The toolbar's counts used to come only from the RSC payload, so a mutation
 * moved the grid and the sidebar but left the heading number standing until a
 * reload. This route is the live source; it must return the same numbers the
 * SSR page computes (`countMaterialsForScope`) and it must not leak another
 * account's counts through a source id that is not the caller's.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    material: { count: vi.fn() },
    feed: { findFirst: vi.fn() },
    folder: { findFirst: vi.fn() },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET } from "@/app/api/posts/counts/route"
import type { NextRequest } from "next/server"

const USER_ID = "user-rad-343"
const FEED_ID = "feed-a"
const FOLDER_ID = "folder-a"

function request(sourceId?: string, folderId?: string): NextRequest {
  const url = new URL("http://localhost/api/posts/counts")
  if (sourceId) url.searchParams.set("sourceId", sourceId)
  if (folderId) url.searchParams.set("folderId", folderId)
  return { nextUrl: url } as unknown as NextRequest
}

function authenticate() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" } as never)
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/posts/counts", () => {
  it("returns the filter and sourceType counts for the account scope", async () => {
    authenticate()
    // Order: total, approved, filtered, sent-to-stories, archived, then the
    // five source types — the shared helper's order, which the SSR page shares.
    vi.mocked(db.material.count)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(60)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(25)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(10)

    const body = await (await GET(request())).json()

    expect(body.filter).toEqual({
      INBOX: 60,
      APPROVED: 60,
      FILTERED: 30,
      SENT_TO_NOTION: 5,
      ARCHIVED: 4,
      ALL: 100,
    })
    expect(body.sourceType).toEqual({
      ALL: 100,
      RSS: 40,
      TELEGRAM: 25,
      TWITTER: 20,
      YOUTUBE: 5,
      EVENT_TRIGGER: 10,
    })
    // Hidden backing feeds stay excluded, as the sidebar and the page do.
    expect(db.material.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ feed: { userId: USER_ID, hidden: false } }) })
    )
  })

  it("scopes every count to the requested source and omits the account-wide type breakdown", async () => {
    authenticate()
    vi.mocked(db.feed.findFirst).mockResolvedValue({ id: FEED_ID } as never)
    vi.mocked(db.material.count).mockResolvedValue(7)

    const body = await (await GET(request(FEED_ID))).json()

    expect(db.feed.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FEED_ID, userId: USER_ID } })
    )
    expect(db.material.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ feed: { userId: USER_ID, id: FEED_ID } }) })
    )
    expect(body.filter).toBeDefined()
    expect(body.sourceType).toBeUndefined()
  })

  it("answers 404 for a source the caller does not own", async () => {
    authenticate()
    vi.mocked(db.feed.findFirst).mockResolvedValue(null)

    const response = await GET(request("feed-someone-else"))

    expect(response.status).toBe(404)
    expect(db.material.count).not.toHaveBeenCalled()
  })

  it("scopes counts to a folder's visible, active members, with the type breakdown", async () => {
    authenticate()
    vi.mocked(db.folder.findFirst).mockResolvedValue({ id: FOLDER_ID } as never)
    vi.mocked(db.material.count).mockResolvedValue(7)

    const body = await (await GET(request(undefined, FOLDER_ID))).json()

    expect(db.folder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FOLDER_ID, userId: USER_ID } })
    )
    expect(db.material.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          feed: { userId: USER_ID, folderId: FOLDER_ID, hidden: false, isActive: true },
        }),
      })
    )
    expect(body.filter).toBeDefined()
    expect(body.sourceType).toBeDefined()
  })

  it("answers 404 for a folder the caller does not own", async () => {
    authenticate()
    vi.mocked(db.folder.findFirst).mockResolvedValue(null)

    const response = await GET(request(undefined, "folder-someone-else"))

    expect(response.status).toBe(404)
    expect(db.material.count).not.toHaveBeenCalled()
  })

  it("returns the auth error response untouched", async () => {
    const unauthorized = { status: 401, json: async () => ({ error: "Unauthorized" }) }
    vi.mocked(requireAuth).mockResolvedValue(unauthorized as never)
    vi.mocked(isErrorResponse).mockReturnValue(true)

    const response = await GET(request())

    expect(response).toBe(unauthorized)
    expect(db.material.count).not.toHaveBeenCalled()
  })
})
