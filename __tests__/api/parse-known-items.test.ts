/**
 * RAD-395 wiring — POST /api/parse (the legacy one-shot route) passes
 * `knownItems` to parseRSSFeed, same as /api/parse-stream.
 *
 * Harness lifted from `parse-backfill.test.ts` (mock-based, no DB).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    feed: { findMany: vi.fn(), update: vi.fn() },
    material: { findMany: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((v: unknown) => v instanceof Response),
}))
vi.mock("@/lib/subscription", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/subscription")>()
  return { ...original, requireActiveSubscription: vi.fn(async () => null) }
})
vi.mock("@/lib/parsers/rss", () => ({ parseRSSFeed: vi.fn() }))
vi.mock("@/lib/parsers/telegram", () => ({ parseTelegramChannel: vi.fn() }))
vi.mock("@/lib/parsers/twitter", () => ({ parseTwitterSource: vi.fn(), parseSourceUrlToConfig: vi.fn() }))
vi.mock("@/lib/parsers/youtube", () => ({ parseYouTubeChannel: vi.fn() }))
vi.mock("@/lib/parsers/interest", () => ({ parseInterestSource: vi.fn() }))
vi.mock("@/lib/ai", () => ({ evaluateMaterialsBatch: vi.fn() }))
vi.mock("@/lib/entitlements", () => ({
  subscriptionIncludesTwitter: vi.fn(() => true),
  getTwitterEntitlement: vi.fn(async () => ({ includesTwitter: true })),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))

import { db } from "@/lib/db"
import { requireAuth } from "@/lib/auth-utils"
import { parseRSSFeed } from "@/lib/parsers/rss"

const USER_ID = "user-known-002"
const SOURCE = {
  id: "src-known-002",
  name: "Behance Featured",
  type: "RSS",
  url: "https://feeds.feedburner.com/behance/vorr",
  isActive: true,
  userId: USER_ID,
  includeRetweets: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" } as never)
  vi.mocked(db.feed.findMany).mockResolvedValue([SOURCE] as never)
  vi.mocked(db.feed.update).mockResolvedValue({} as never)
  vi.mocked(db.material.findMany).mockResolvedValue([] as never)
  vi.mocked(parseRSSFeed).mockResolvedValue([])
})

// Warm-up at collection time (see parse-youtube-dispatch / parse-backfill).
await import("@/app/api/parse/route")

describe("POST /api/parse — RSS sources pass knownItems (RAD-395)", () => {
  it("AC-4: parseRSSFeed is called with (source.url, { knownItems }) and the callback reads this source's stored materials", async () => {
    const { POST } = await import("@/app/api/parse/route")
    await POST(new NextRequest(new URL("http://localhost/api/parse"), { method: "POST", body: JSON.stringify({}) }))

    expect(parseRSSFeed).toHaveBeenCalledTimes(1)
    expect(parseRSSFeed).toHaveBeenCalledWith(SOURCE.url, expect.objectContaining({ knownItems: expect.any(Function) }))

    const { knownItems } = vi.mocked(parseRSSFeed).mock.calls[0][1] as unknown as {
      knownItems: (c: { url: string; externalId: string }[]) => Promise<Set<string>>
    }
    vi.mocked(db.material.findMany).mockClear()
    vi.mocked(db.material.findMany).mockResolvedValue([{ url: "https://www.behance.net/gallery/1/a", externalId: "g-1" }] as never)

    const known = await knownItems([{ url: "https://www.behance.net/gallery/1/a", externalId: "g-1" }])

    expect([...known].sort()).toEqual(["g-1", "https://www.behance.net/gallery/1/a"])
    const args = vi.mocked(db.material.findMany).mock.calls[0][0] as { where: { sourceId: string } }
    expect(args.where.sourceId).toBe(SOURCE.id)
  })
})
