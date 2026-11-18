/**
 * POST /api/onboarding/validate-feed — RSS feed URL validation
 *
 * Tests valid/invalid RSS detection, SSRF protection via isAllowedUrl,
 * and edge cases.
 * RAD-178
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("rss-parser", () => {
  const MockParser = vi.fn()
  MockParser.prototype.parseURL = vi.fn()
  return { default: MockParser }
})

import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import RSSParser from "rss-parser"
import { POST } from "@/app/api/onboarding/validate-feed/route"

const USER_ID = "user-val-123"

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupUnauth() {
  const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  vi.mocked(requireAuth).mockResolvedValue(res as never)
  vi.mocked(isErrorResponse).mockReturnValue(true)
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/onboarding/validate-feed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => vi.clearAllMocks())

describe("POST /api/onboarding/validate-feed", () => {
  it("returns 401 when not authenticated", async () => {
    setupUnauth()
    const res = await POST(makeRequest({ url: "https://example.com/feed" }))
    expect(res.status).toBe(401)
  })

  it("returns valid feed info for a valid RSS URL", async () => {
    setupAuth()
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Example Blog",
      items: Array.from({ length: 10 }, () => ({ title: "Article" })),
    } as never)

    const res = await POST(makeRequest({ url: "https://example.com/feed.xml" }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({
      valid: true,
      name: "Example Blog",
      itemCount: 10,
    })
  })

  it("returns valid:false when parser throws", async () => {
    setupAuth()
    vi.mocked(RSSParser.prototype.parseURL).mockRejectedValue(new Error("Not a feed"))

    const res = await POST(makeRequest({ url: "https://example.com/not-a-feed" }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({
      valid: false,
      error: "Not a valid RSS/Atom feed",
    })
  })

  it("falls back to hostname when feed has no title", async () => {
    setupAuth()
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "",
      items: [],
    } as never)

    const res = await POST(makeRequest({ url: "https://blog.example.com/rss" }))
    const data = await res.json()
    expect(data.valid).toBe(true)
    expect(data.name).toBe("blog.example.com")
  })

  it("returns itemCount 0 when feed has no items", async () => {
    setupAuth()
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Empty Feed",
      items: undefined,
    } as never)

    const res = await POST(makeRequest({ url: "https://example.com/empty.xml" }))
    const data = await res.json()
    expect(data.valid).toBe(true)
    expect(data.itemCount).toBe(0)
  })

  describe("Input validation", () => {
    it("rejects missing URL", async () => {
      setupAuth()
      const res = await POST(makeRequest({}))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.valid).toBe(false)
    })

    it("rejects non-string URL", async () => {
      setupAuth()
      const res = await POST(makeRequest({ url: 123 }))
      expect(res.status).toBe(400)
    })
  })

  describe("SSRF protection", () => {
    it("rejects localhost URL", async () => {
      setupAuth()
      const res = await POST(makeRequest({ url: "http://localhost:8080/feed" }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.valid).toBe(false)
      expect(data.error).toBe("Invalid URL")
    })

    it("rejects 127.0.0.1", async () => {
      setupAuth()
      const res = await POST(makeRequest({ url: "http://127.0.0.1/feed" }))
      expect(res.status).toBe(400)
    })

    it("rejects private IP 192.168.x.x", async () => {
      setupAuth()
      const res = await POST(makeRequest({ url: "http://192.168.1.1/feed" }))
      expect(res.status).toBe(400)
    })

    it("rejects private IP 10.x.x.x", async () => {
      setupAuth()
      const res = await POST(makeRequest({ url: "http://10.0.0.1/feed" }))
      expect(res.status).toBe(400)
    })

    it("rejects .internal domain", async () => {
      setupAuth()
      const res = await POST(makeRequest({ url: "http://app.internal/feed" }))
      expect(res.status).toBe(400)
    })
  })

  it("handles URL with query parameters", async () => {
    setupAuth()
    vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
      title: "Feed",
      items: [{ title: "Item" }],
    } as never)

    const res = await POST(makeRequest({ url: "https://example.com/feed.xml?format=rss&lang=en" }))
    const data = await res.json()
    expect(data.valid).toBe(true)
  })
})
