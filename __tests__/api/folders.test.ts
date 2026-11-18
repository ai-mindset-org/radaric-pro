/**
 * Source folders API (RAD-393):
 *   POST   /api/folders          — create
 *   PATCH  /api/folders/[id]     — rename
 *   DELETE /api/folders/[id]     — delete (sources survive: FK SetNull)
 *   PATCH  /api/feeds/[id]/folder — move a source in/out (null = uncategorized)
 *
 * House pattern: mocked `@/lib/db`, assert on the arguments Prisma receives.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { revalidatePath } from "next/cache"

vi.mock("@/lib/db", () => ({
  db: {
    folder: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    feed: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { POST } from "@/app/api/folders/route"
import { PATCH as PATCH_FOLDER, DELETE } from "@/app/api/folders/[id]/route"
import { PATCH as PATCH_MOVE } from "@/app/api/feeds/[id]/folder/route"

const USER_ID = "user-1"
const FOLDER_ID = "folder-1"
const FEED_ID = "feed-1"
const folderParams = Promise.resolve({ id: FOLDER_ID })
const feedParams = Promise.resolve({ id: FEED_ID })

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, { method, body: JSON.stringify(body) })
}

beforeEach(() => vi.clearAllMocks())

describe("POST /api/folders", () => {
  it("creates a folder with trimmed name and case-folded uniqueness key", async () => {
    setupAuth()
    vi.mocked(db.folder.findFirst).mockResolvedValue(null)
    vi.mocked(db.folder.create).mockResolvedValue({
      id: FOLDER_ID,
      name: "Design",
    } as never)

    const res = await POST(jsonRequest("http://localhost/api/folders", "POST", { name: "  Design  " }))

    expect(res.status).toBe(201)
    expect(db.folder.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, name: "Design", nameLower: "design" },
      select: { id: true, name: true },
    })
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("rejects an empty or whitespace-only name without touching the DB", async () => {
    setupAuth()
    const res = await POST(jsonRequest("http://localhost/api/folders", "POST", { name: "   " }))
    expect(res.status).toBe(400)
    expect(db.folder.create).not.toHaveBeenCalled()
  })

  it("rejects a name longer than 60 characters", async () => {
    setupAuth()
    const res = await POST(
      jsonRequest("http://localhost/api/folders", "POST", { name: "x".repeat(61) })
    )
    expect(res.status).toBe(400)
    expect(db.folder.create).not.toHaveBeenCalled()
  })

  it("returns 409 when a case-variant name already exists", async () => {
    setupAuth()
    vi.mocked(db.folder.findFirst).mockResolvedValue({ id: "other" } as never)

    const res = await POST(jsonRequest("http://localhost/api/folders", "POST", { name: "DESIGN" }))

    expect(res.status).toBe(409)
    expect(db.folder.findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, nameLower: "design" },
      select: { id: true },
    })
    expect(db.folder.create).not.toHaveBeenCalled()
  })

  it("maps a P2002 unique violation to 409 (the race the pre-check cannot close)", async () => {
    setupAuth()
    vi.mocked(db.folder.findFirst).mockResolvedValue(null)
    vi.mocked(db.folder.create).mockRejectedValue({ code: "P2002" })

    const res = await POST(jsonRequest("http://localhost/api/folders", "POST", { name: "Design" }))
    expect(res.status).toBe(409)
  })
})

describe("PATCH /api/folders/[id]", () => {
  it("renames a folder and updates the uniqueness key", async () => {
    setupAuth()
    vi.mocked(db.folder.findUnique).mockResolvedValue({
      id: FOLDER_ID,
      nameLower: "design",
    } as never)
    vi.mocked(db.folder.findFirst).mockResolvedValue(null)
    vi.mocked(db.folder.update).mockResolvedValue({ id: FOLDER_ID, name: "Product design" } as never)

    const res = await PATCH_FOLDER(
      jsonRequest(`http://localhost/api/folders/${FOLDER_ID}`, "PATCH", { name: "Product design" }),
      { params: folderParams }
    )

    expect(res.status).toBe(200)
    expect(db.folder.update).toHaveBeenCalledWith({
      where: { id: FOLDER_ID },
      data: { name: "Product design", nameLower: "product design" },
      select: { id: true, name: true },
    })
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("allows a case-only rename without colliding with itself", async () => {
    setupAuth()
    vi.mocked(db.folder.findUnique).mockResolvedValue({
      id: FOLDER_ID,
      nameLower: "design",
    } as never)
    vi.mocked(db.folder.update).mockResolvedValue({ id: FOLDER_ID, name: "Design" } as never)

    const res = await PATCH_FOLDER(
      jsonRequest(`http://localhost/api/folders/${FOLDER_ID}`, "PATCH", { name: "Design" }),
      { params: folderParams }
    )

    expect(res.status).toBe(200)
    expect(db.folder.findFirst).not.toHaveBeenCalled()
  })

  it("returns 404 for a folder the caller does not own", async () => {
    setupAuth()
    vi.mocked(db.folder.findUnique).mockResolvedValue(null)

    const res = await PATCH_FOLDER(
      jsonRequest(`http://localhost/api/folders/${FOLDER_ID}`, "PATCH", { name: "Mine" }),
      { params: folderParams }
    )

    expect(res.status).toBe(404)
    expect(db.folder.findUnique).toHaveBeenCalledWith({
      where: { id: FOLDER_ID, userId: USER_ID },
      select: { id: true, nameLower: true },
    })
    expect(db.folder.update).not.toHaveBeenCalled()
  })

  it("returns 409 when renaming onto another folder's name", async () => {
    setupAuth()
    vi.mocked(db.folder.findUnique).mockResolvedValue({
      id: FOLDER_ID,
      nameLower: "design",
    } as never)
    vi.mocked(db.folder.findFirst).mockResolvedValue({ id: "other" } as never)

    const res = await PATCH_FOLDER(
      jsonRequest(`http://localhost/api/folders/${FOLDER_ID}`, "PATCH", { name: "Tech" }),
      { params: folderParams }
    )

    expect(res.status).toBe(409)
    expect(db.folder.findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, nameLower: "tech", NOT: { id: FOLDER_ID } },
      select: { id: true },
    })
    expect(db.folder.update).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/folders/[id]", () => {
  it("deletes an owned folder without touching its sources", async () => {
    setupAuth()
    vi.mocked(db.folder.findUnique).mockResolvedValue({ id: FOLDER_ID } as never)
    vi.mocked(db.folder.delete).mockResolvedValue({} as never)

    const res = await DELETE(
      new NextRequest(`http://localhost/api/folders/${FOLDER_ID}`, { method: "DELETE" }),
      { params: folderParams }
    )

    expect(res.status).toBe(200)
    expect(db.folder.delete).toHaveBeenCalledWith({ where: { id: FOLDER_ID } })
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("returns 404 for a foreign folder", async () => {
    setupAuth()
    vi.mocked(db.folder.findUnique).mockResolvedValue(null)

    const res = await DELETE(
      new NextRequest(`http://localhost/api/folders/${FOLDER_ID}`, { method: "DELETE" }),
      { params: folderParams }
    )

    expect(res.status).toBe(404)
    expect(db.folder.delete).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/feeds/[id]/folder", () => {
  it("moves a source into an owned folder", async () => {
    setupAuth()
    vi.mocked(db.feed.findUnique).mockResolvedValue({ id: FEED_ID, hidden: false } as never)
    vi.mocked(db.folder.findUnique).mockResolvedValue({ id: FOLDER_ID } as never)
    vi.mocked(db.feed.update).mockResolvedValue({ id: FEED_ID, folderId: FOLDER_ID } as never)

    const res = await PATCH_MOVE(
      jsonRequest(`http://localhost/api/feeds/${FEED_ID}/folder`, "PATCH", { folderId: FOLDER_ID }),
      { params: feedParams }
    )

    expect(res.status).toBe(200)
    expect(db.feed.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { folderId: FOLDER_ID },
      select: { id: true, folderId: true },
    })
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("unfiles a source with folderId null and does not look up a folder", async () => {
    setupAuth()
    vi.mocked(db.feed.findUnique).mockResolvedValue({ id: FEED_ID, hidden: false } as never)
    vi.mocked(db.feed.update).mockResolvedValue({ id: FEED_ID, folderId: null } as never)

    const res = await PATCH_MOVE(
      jsonRequest(`http://localhost/api/feeds/${FEED_ID}/folder`, "PATCH", { folderId: null }),
      { params: feedParams }
    )

    expect(res.status).toBe(200)
    expect(db.folder.findUnique).not.toHaveBeenCalled()
    expect(db.feed.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { folderId: null },
      select: { id: true, folderId: true },
    })
  })

  it("404s a foreign feed (userId scoping)", async () => {
    setupAuth()
    vi.mocked(db.feed.findUnique).mockResolvedValue(null)

    const res = await PATCH_MOVE(
      jsonRequest(`http://localhost/api/feeds/${FEED_ID}/folder`, "PATCH", { folderId: FOLDER_ID }),
      { params: feedParams }
    )

    expect(res.status).toBe(404)
    expect(db.feed.findUnique).toHaveBeenCalledWith({
      where: { id: FEED_ID, userId: USER_ID },
      select: { id: true, hidden: true },
    })
    expect(db.feed.update).not.toHaveBeenCalled()
  })

  it("404s a hidden collection monitor feed", async () => {
    setupAuth()
    vi.mocked(db.feed.findUnique).mockResolvedValue({ id: FEED_ID, hidden: true } as never)

    const res = await PATCH_MOVE(
      jsonRequest(`http://localhost/api/feeds/${FEED_ID}/folder`, "PATCH", { folderId: FOLDER_ID }),
      { params: feedParams }
    )

    expect(res.status).toBe(404)
    expect(db.feed.update).not.toHaveBeenCalled()
  })

  it("404s a foreign folder target", async () => {
    setupAuth()
    vi.mocked(db.feed.findUnique).mockResolvedValue({ id: FEED_ID, hidden: false } as never)
    vi.mocked(db.folder.findUnique).mockResolvedValue(null)

    const res = await PATCH_MOVE(
      jsonRequest(`http://localhost/api/feeds/${FEED_ID}/folder`, "PATCH", { folderId: FOLDER_ID }),
      { params: feedParams }
    )

    expect(res.status).toBe(404)
    expect(db.feed.update).not.toHaveBeenCalled()
  })

  it("rejects a malformed body", async () => {
    setupAuth()
    const res = await PATCH_MOVE(
      jsonRequest(`http://localhost/api/feeds/${FEED_ID}/folder`, "PATCH", { folderId: 42 }),
      { params: feedParams }
    )
    expect(res.status).toBe(400)
    expect(db.feed.update).not.toHaveBeenCalled()
  })
})
