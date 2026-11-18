/**
 * RAD-393 — folder scope on the two SSE routes (group-stories, refilter).
 *
 * Both early-return with zero eligible materials, so the scope is asserted on
 * the query that decides eligibility — no pipeline is reached. A folder with no
 * visible members must be an empty run, never an accidental account-wide one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn() },
    material: { findMany: vi.fn(), count: vi.fn() },
    feed: { findMany: vi.fn() },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/rate-limit", () => ({
  checkUserRateLimit: vi.fn(() => null),
  RATE_LIMITS: { groupStories: {}, refilter: {} },
}))

vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn().mockResolvedValue(null),
}))

vi.mock("@/lib/subscription", () => ({
  hasActiveAccess: vi.fn(() => true),
  requireActiveSubscription: vi.fn(),
}))

vi.mock("@/lib/story-aggregator/pipeline-deps", () => ({
  buildMaterialStoryDeps: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET as GROUP_GET, POST as GROUP_POST } from "@/app/api/posts/group-stories/route"
import { GET as REFILTER_GET } from "@/app/api/posts/refilter/route"

const USER_ID = "user-rad-393"
const FOLDER_ID = "folder-1"

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" } as never)
  vi.mocked(isErrorResponse).mockReturnValue(false)
  vi.mocked(db.user.findUnique).mockResolvedValue(null as never)
  vi.mocked(db.material.findMany).mockResolvedValue([] as never)
  vi.mocked(db.material.count).mockResolvedValue(0 as never)
  vi.mocked(db.feed.findMany).mockResolvedValue([] as never)
})

describe("GET /api/posts/group-stories — folder scope", () => {
  it("scopes the ungrouped pool to the folder's visible, active members", async () => {
    const res = await GROUP_GET(request(`/api/posts/group-stories?folderId=${FOLDER_ID}`))
    await res.text()

    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          feed: { userId: USER_ID, hidden: false, isActive: true, folderId: FOLDER_ID },
        }),
      })
    )
  })

  it("keeps the account-wide pool without a folder", async () => {
    const res = await GROUP_GET(request("/api/posts/group-stories"))
    await res.text()

    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ feed: { userId: USER_ID, hidden: false } }),
      })
    )
  })

  it("scopes the POST fallback pool to the folder too (handlers cannot disagree)", async () => {
    const res = await GROUP_POST(
      new NextRequest(`http://localhost/api/posts/group-stories?folderId=${FOLDER_ID}`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(200)

    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          feed: { userId: USER_ID, hidden: false, isActive: true, folderId: FOLDER_ID },
        }),
      })
    )
  })

  it("keeps the POST fallback pool account-wide without a folder", async () => {
    const res = await GROUP_POST(
      new NextRequest("http://localhost/api/posts/group-stories", {
        method: "POST",
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(200)

    expect(db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ feed: { userId: USER_ID, hidden: false } }),
      })
    )
  })
})

describe("GET /api/posts/refilter — folder scope", () => {
  it("resolves the folder's visible members and scopes eligibility to them", async () => {
    vi.mocked(db.feed.findMany).mockResolvedValue([{ id: "src-a" }, { id: "src-b" }] as never)

    const res = await REFILTER_GET(request(`/api/posts/refilter?folderId=${FOLDER_ID}`))
    await res.text()

    expect(db.feed.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, folderId: FOLDER_ID, hidden: false, isActive: true },
      select: { id: true },
    })
    expect(db.material.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceId: { in: ["src-a", "src-b"] } }),
      })
    )
  })

  it("an empty folder is an empty run, never account-wide", async () => {
    vi.mocked(db.feed.findMany).mockResolvedValue([] as never)

    const res = await REFILTER_GET(request(`/api/posts/refilter?folderId=${FOLDER_ID}`))
    await res.text()

    expect(db.material.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceId: { in: [] } }),
      })
    )
  })
})
