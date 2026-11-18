/**
 * RAD-317 — `/api/posts?sourceId=…` must not apply the global `hidden: false`.
 *
 * The two query paths disagree today. SSR scopes an explicitly chosen feed by
 * id *without* the hidden filter (`lib/materials/fetch-materials-page.ts:126`),
 * while this route applies `hidden: false` unconditionally. Once the client
 * starts sending `sourceId` (RAD-317), a hidden monitor feed's page would SSR
 * with content and then render empty on the first client fetch.
 *
 * Ownership is unaffected: `feed.userId` still scopes every query to the caller.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures and Prisma where-builder mocks */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: { material: { findMany: vi.fn(), count: vi.fn() } },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET } from "@/app/api/posts/route"

const USER_ID = "user-1"

/** The `where` the route handed to Prisma for the last request. */
function lastWhere(): any {
  const calls = (db.material.findMany as any).mock.calls
  return calls.at(-1)[0].where
}

async function get(query: string) {
  const req = { nextUrl: new URL(`http://localhost/api/posts?${query}`) } as any
  await GET(req)
  return lastWhere()
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(requireAuth as any).mockResolvedValue({ userId: USER_ID })
  ;(isErrorResponse as any).mockReturnValue(false)
  ;(db.material.findMany as any).mockResolvedValue([])
  ;(db.material.count as any).mockResolvedValue(0)
})

describe("RAD-317: /api/posts hidden-feed scoping", () => {
  it("drops hidden:false when a sourceId is given, keeping ownership", async () => {
    const where = await get("sourceId=feed-a&filter=INBOX")

    expect(where.sourceId).toBe("feed-a")
    expect(where.feed.userId).toBe(USER_ID)
    expect(where.feed).not.toHaveProperty("hidden")
  })

  it("still hides monitor feeds on the global view", async () => {
    const where = await get("filter=INBOX")

    expect(where.feed).toEqual({ userId: USER_ID, hidden: false })
  })

  it("drops hidden:false in the search branch too", async () => {
    const where = await get("sourceId=feed-a&search=design&filter=INBOX")

    const feedScopes = where.AND
      .map((clause: any) => clause.feed)
      .filter((feed: any) => feed && "userId" in feed)

    expect(feedScopes.length).toBeGreaterThan(0)
    for (const feed of feedScopes) {
      expect(feed.userId).toBe(USER_ID)
      expect(feed).not.toHaveProperty("hidden")
    }
  })

  it("keeps hidden:false in the search branch on the global view", async () => {
    const where = await get("search=design&filter=INBOX")

    const feedScopes = where.AND
      .map((clause: any) => clause.feed)
      .filter((feed: any) => feed && "userId" in feed)

    expect(feedScopes.length).toBeGreaterThan(0)
    for (const feed of feedScopes) {
      expect(feed.hidden).toBe(false)
    }
  })
})
