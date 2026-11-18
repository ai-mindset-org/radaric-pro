/**
 * RAD-395 wiring — GET /api/parse-stream passes `knownItems` to parseRSSFeed,
 * so stored items skip their article-page fetch (the routes' dedupe used to
 * drop ~16 of 20 freshly fetched pages right after the parser paid for them).
 *
 * Harness lifted from `parse-stream-bulk-writes.test.ts` (mock-based, no DB).
 * The callback is also invoked to prove it is bound to THIS source's id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    feed: { findMany: vi.fn(), update: vi.fn() },
    material: { findMany: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/parsers/rss", () => ({ parseRSSFeed: vi.fn() }))
vi.mock("@/lib/parsers/telegram", () => ({ parseTelegramChannel: vi.fn() }))
vi.mock("@/lib/parsers/twitter", () => ({ parseTwitterSource: vi.fn(), parseSourceUrlToConfig: vi.fn() }))
vi.mock("@/lib/parsers/interest", () => ({ parseInterestSource: vi.fn() }))
vi.mock("@/lib/ai", () => ({ evaluateMaterialsBatch: vi.fn() }))
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { parseRSSFeed } from "@/lib/parsers/rss"
import { GET } from "@/app/api/parse-stream/route"

const USER_ID = "user-known-001"
const SOURCE = {
  id: "src-known-001",
  name: "Behance Featured",
  type: "RSS",
  url: "https://feeds.feedburner.com/behance/vorr",
  isActive: true,
  userId: USER_ID,
  parallelMonitorId: null,
  includeRetweets: false,
}

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader()
  while (!(await reader.read()).done) { /* drain */ }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID, role: "USER" } } as never)
  vi.mocked(db.user.findUnique).mockResolvedValue({
    id: USER_ID,
    userSettings: { onboardingCompleted: true },
    subscription: { status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 86_400_000), cancelAtPeriodEnd: false },
  } as never)
  vi.mocked(db.feed.findMany).mockResolvedValue([SOURCE] as never)
  vi.mocked(db.feed.update).mockResolvedValue({} as never)
  vi.mocked(db.material.findMany).mockResolvedValue([] as never)
  vi.mocked(parseRSSFeed).mockResolvedValue([])
})

describe("GET /api/parse-stream — RSS sources pass knownItems (RAD-395)", () => {
  it("AC-4: parseRSSFeed is called with (source.url, { knownItems }) and the callback reads this source's stored materials", async () => {
    await drain(await GET(new NextRequest(new URL("http://localhost/api/parse-stream"))))

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
