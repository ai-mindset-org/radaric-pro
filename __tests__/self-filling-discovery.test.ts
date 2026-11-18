/**
 * Self-filling Slice 3 — LLM source discovery (lib/saved/discovery.ts).
 *
 * Load-bearing behavior: only suggestions that VALIDATE into a real, reachable
 * RSS feed reach the user (no hallucinated/dead URLs), resolved either as a
 * direct feed or via the site's advertised feed; deduped; flagged if already a
 * feed the user has; the dropped count is surfaced via `suggested`.
 */

import { it, expect, vi, beforeEach } from "vitest"

const { parseString } = vi.hoisted(() => ({ parseString: vi.fn() }))
vi.mock("rss-parser", () => ({ default: class { parseString = parseString } }))
vi.mock("ai", () => ({ generateObject: vi.fn() }))
vi.mock("@/lib/ai", () => ({ createModel: vi.fn(async () => ({})) }))
vi.mock("@/lib/parsers/rss", () => ({ detectRSSFeed: vi.fn() }))
vi.mock("@/lib/url-validation", () => ({ safeFetch: vi.fn() }))
vi.mock("@/lib/db", () => ({
  db: { settings: { findFirst: vi.fn() }, feed: { findMany: vi.fn() } },
}))

import { generateObject } from "ai"
import { detectRSSFeed } from "@/lib/parsers/rss"
import { safeFetch } from "@/lib/url-validation"
import { db } from "@/lib/db"
import { discoverSourcesForTopic, AiNotConfiguredError } from "@/lib/saved/discovery"

const genObject = generateObject as ReturnType<typeof vi.fn>
const detect = detectRSSFeed as ReturnType<typeof vi.fn>
const fetchMock = safeFetch as ReturnType<typeof vi.fn>
const mockDb = db as unknown as {
  settings: { findFirst: ReturnType<typeof vi.fn> }
  feed: { findMany: ReturnType<typeof vi.fn> }
}

const USER = "user-1"

function suggest(...sources: Array<{ name: string; url: string; reason: string }>) {
  genObject.mockResolvedValue({ object: { sources } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.settings.findFirst.mockResolvedValue({ id: "s1", aiModel: "claude-sonnet-4-6", discoveryModel: "claude-sonnet-4-6", aiApiKey: "k", aiTemperature: 0.3 })
  mockDb.feed.findMany.mockResolvedValue([])
  detect.mockResolvedValue(null)
  // safeFetch always succeeds with some body; parseString decides feed-or-not.
  fetchMock.mockResolvedValue({ ok: true, text: async () => "<rss/>" })
  parseString.mockRejectedValue(new Error("not a feed"))
})

it("keeps a suggestion whose URL is itself a valid feed", async () => {
  suggest({ name: "Euractiv Tech", url: "https://euractiv.com/feed.xml", reason: "covers EU tech policy" })
  parseString.mockResolvedValueOnce({ title: "EURACTIV — Technology" })

  const out = await discoverSourcesForTopic("EU AI Act enforcement", USER)

  expect(out.sources).toEqual([
    { name: "EURACTIV — Technology", feedUrl: "https://euractiv.com/feed.xml", reason: "covers EU tech policy", alreadyAdded: false },
  ])
  expect(detect).not.toHaveBeenCalled() // direct feed → no site probe
  expect(out.suggested).toBe(1)
})

it("resolves a site URL to its advertised RSS feed", async () => {
  suggest({ name: "MLex", url: "https://mlex.com", reason: "regulatory news" })
  // 1st validateFeed (the site URL) fails to parse; detect finds a feed; 2nd validateFeed succeeds.
  parseString.mockRejectedValueOnce(new Error("html, not a feed"))
  detect.mockResolvedValueOnce("https://mlex.com/rss")
  parseString.mockResolvedValueOnce({ title: "MLex AI" })

  const out = await discoverSourcesForTopic("EU AI Act enforcement", USER)

  expect(out.sources).toEqual([
    { name: "MLex AI", feedUrl: "https://mlex.com/rss", reason: "regulatory news", alreadyAdded: false },
  ])
})

it("drops suggestions that resolve to no feed", async () => {
  suggest({ name: "Dead Site", url: "https://nope.example", reason: "—" })
  // parseString rejects (not a feed), detect returns null → unresolvable
  const out = await discoverSourcesForTopic("q", USER)
  expect(out.sources).toEqual([])
  expect(out.suggested).toBe(1) // dropped count surfaced
})

it("drops non-http suggestions before any network call", async () => {
  suggest({ name: "Bad", url: "ftp://x", reason: "—" })
  const out = await discoverSourcesForTopic("q", USER)
  expect(out.sources).toEqual([])
  expect(fetchMock).not.toHaveBeenCalled()
  expect(detect).not.toHaveBeenCalled()
})

it("dedups by resolved feed URL", async () => {
  suggest(
    { name: "A", url: "https://a.com/feed", reason: "one" },
    { name: "B", url: "https://a.com/feed", reason: "two" }
  )
  parseString.mockResolvedValue({ title: "Feed A" }) // both resolve as direct feeds

  const out = await discoverSourcesForTopic("q", USER)
  expect(out.sources).toHaveLength(1)
  expect(out.sources[0].feedUrl).toBe("https://a.com/feed")
})

it("flags feeds the user already has", async () => {
  suggest(
    { name: "Have", url: "https://have.com/feed", reason: "—" },
    { name: "New", url: "https://new.com/feed", reason: "—" }
  )
  parseString.mockResolvedValue({ title: "F" })
  mockDb.feed.findMany.mockResolvedValue([{ url: "https://have.com/feed" }])

  const out = await discoverSourcesForTopic("q", USER)
  const byUrl = Object.fromEntries(out.sources.map((s) => [s.feedUrl, s.alreadyAdded]))
  expect(byUrl["https://have.com/feed"]).toBe(true)
  expect(byUrl["https://new.com/feed"]).toBe(false)
})

it("throws AiNotConfiguredError when no AI key is configured", async () => {
  mockDb.settings.findFirst.mockResolvedValue({ id: "s1", aiModel: "claude-sonnet-4-6", discoveryModel: "claude-sonnet-4-6", aiApiKey: null, aiTemperature: 0.3 })
  const prev = { anthropic: process.env.ANTHROPIC_API_KEY, openrouter: process.env.OPENROUTER_API_KEY }
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    await expect(discoverSourcesForTopic("q", USER)).rejects.toBeInstanceOf(AiNotConfiguredError)
    expect(genObject).not.toHaveBeenCalled()
  } finally {
    if (prev.anthropic) process.env.ANTHROPIC_API_KEY = prev.anthropic
    if (prev.openrouter) process.env.OPENROUTER_API_KEY = prev.openrouter
  }
})
