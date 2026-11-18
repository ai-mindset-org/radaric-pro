// @vitest-environment node

/**
 * RAD-296 — route-level wiring of the rate limiter.
 *
 * Pinned here:
 *  - signup is the unified signup/signin endpoint: account creation draws from
 *    a per-IP budget, sign-in from a per-(IP,email) budget;
 *  - authenticated routes bucket by USER ID and exempt ADMIN;
 *  - the SSE routes reject BEFORE opening a stream (real 401/429 statuses).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => {
  const user = { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn(async () => 1) }
  const $executeRaw = vi.fn(async () => 1)
  return {
    db: {
      user,
      $executeRaw,
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function" ? await (arg as (tx: unknown) => unknown)({ user, $executeRaw }) : arg
      ),
    },
  }
})

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(() => false),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

vi.mock("@/lib/parsers/rss", () => ({
  detectRSSFeed: vi.fn(),
}))

// RAD-297: these tests cover rate limiting; the email-verification gate that
// runs beside it is covered by email-verification tests.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(async () => false),
    hash: vi.fn(async () => "hashed"),
  },
}))

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { auth } from "@/lib/auth"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { POST as signupPOST } from "@/app/api/auth/signup/route"
import { POST as parseFeedsPOST } from "@/app/api/onboarding/parse-feeds/route"
import { GET as parseStreamGET } from "@/app/api/parse-stream/route"
import { GET as refilterGET } from "@/app/api/posts/refilter/route"
import { GET as groupStoriesGET } from "@/app/api/posts/group-stories/route"
import { RATE_LIMITS, rateLimit, resetRateLimits } from "@/lib/rate-limit"

const mockUser = db.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

/** Fill a bucket to its limit so the next call is blocked. */
function exhaust(name: string, key: string, opts: { limit: number; windowMs: number }) {
  for (let i = 0; i < opts.limit; i++) {
    rateLimit(name, key, opts.limit, opts.windowMs)
  }
}

function signupRequest(ip: string, body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimits()
  mockUser.findUnique.mockResolvedValue(null)
  mockUser.create.mockResolvedValue({ id: "u1" })
})

describe("POST /api/auth/signup — creation budget (RAD-296)", () => {
  it("caps account-creation attempts per IP and answers 429 with Retry-After", async () => {
    const limit = RATE_LIMITS.signupIp.limit
    for (let i = 0; i < limit; i++) {
      const res = await signupPOST(signupRequest("198.51.100.7", { email: `new-${i}@example.com`, password: "long-enough" }))
      expect(res.status).not.toBe(429)
    }

    const res = await signupPOST(signupRequest("198.51.100.7", { email: "new-final@example.com", password: "long-enough" }))
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBeTruthy()
    const body = await res.json()
    expect(body.code).toBe("RATE_LIMITED")
  })

  it("does not bucket a different IP into the same window", async () => {
    const limit = RATE_LIMITS.signupIp.limit
    for (let i = 0; i < limit; i++) {
      const res = await signupPOST(signupRequest("198.51.100.7", { email: `new-${i}@example.com`, password: "long-enough" }))
      expect(res.status).not.toBe(429)
    }
    const other = await signupPOST(signupRequest("203.0.113.50", { email: "new-final@example.com", password: "long-enough" }))
    expect(other.status).not.toBe(429)
  })
})

describe("POST /api/auth/signup — sign-in budget (RAD-296)", () => {
  it("uses a looser per-(IP,email) budget for an existing account, independent of creation", async () => {
    mockUser.findUnique.mockResolvedValue({ id: "u1", passwordHash: "hash", role: "USER" })
    const limit = RATE_LIMITS.signupSignin.limit
    const attempt = () => signupPOST(signupRequest("198.51.100.7", { email: "user@example.com", password: "wrong-password" }))

    for (let i = 0; i < limit; i++) {
      const res = await attempt()
      expect(res.status).toBe(400) // wrong password, but not limited
    }
    const res = await attempt()
    expect(res.status).toBe(429)

    // A different email on the same IP is a different sign-in bucket.
    const other = await signupPOST(signupRequest("198.51.100.7", { email: "other@example.com", password: "wrong-password" }))
    expect(other.status).not.toBe(429)
  })

  it("caps the aggregate per-IP work even when emails rotate (enumeration oracle)", async () => {
    mockUser.findUnique.mockResolvedValue({ id: "u1", passwordHash: "hash", role: "USER" })
    const limit = RATE_LIMITS.signupAll.limit
    for (let i = 0; i < limit; i++) {
      const res = await signupPOST(signupRequest("198.51.100.7", { email: `probe-${i}@example.com`, password: "wrong-password" }))
      expect(res.status).not.toBe(429)
    }
    const res = await signupPOST(signupRequest("198.51.100.7", { email: "probe-final@example.com", password: "wrong-password" }))
    expect(res.status).toBe(429)
  })
})

describe("POST /api/onboarding/parse-feeds — per-user limits (RAD-296)", () => {
  function authed(role: string) {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1", role })
    vi.mocked(isErrorResponse).mockReturnValue(false)
  }

  function formRequest(): Request {
    return new Request("http://localhost/api/onboarding/parse-feeds", { method: "POST", body: new FormData() })
  }

  it("answers 429 past the per-user limit", async () => {
    authed("USER")
    const limit = RATE_LIMITS.onboardingParseFeeds.limit
    for (let i = 0; i < limit; i++) {
      const res = await parseFeedsPOST(formRequest())
      expect(res.status).not.toBe(429)
    }
    const res = await parseFeedsPOST(formRequest())
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBeTruthy()
  })

  it("never limits ADMIN", async () => {
    authed("ADMIN")
    for (let i = 0; i < RATE_LIMITS.onboardingParseFeeds.limit + 5; i++) {
      const res = await parseFeedsPOST(formRequest())
      expect(res.status).not.toBe(429)
    }
  })
})

describe("SSE routes — blocked callers get a real HTTP status (RAD-296)", () => {
  const req = () => new Request("http://localhost/api/parse-stream")

  it("parse-stream: 401 when unauthenticated, before any stream", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await parseStreamGET(req() as never)
    expect(res.status).toBe(401)
    expect(res.headers.get("content-type")).not.toContain("event-stream")
  })

  it("parse-stream: 429 with Retry-After when the bucket is exhausted", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1", role: "USER" } } as never)
    exhaust("parse-stream", "user-1", RATE_LIMITS.parseStream)
    const res = await parseStreamGET(req() as never)
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBeTruthy()
  })

  it("refilter: 401 when the auth guard fails, 429 when exhausted", async () => {
    vi.mocked(requireAuth).mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    vi.mocked(isErrorResponse).mockReturnValue(true)
    const unauth = await refilterGET(req() as never)
    expect(unauth.status).toBe(401)

    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-2", role: "USER" })
    vi.mocked(isErrorResponse).mockReturnValue(false)
    exhaust("refilter", "user-2", RATE_LIMITS.refilter)
    const limited = await refilterGET(req() as never)
    expect(limited.status).toBe(429)
    expect(limited.headers.get("Retry-After")).toBeTruthy()
  })

  it("group-stories: 429 when exhausted (the UI calls the GET handler)", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-3", role: "USER" })
    vi.mocked(isErrorResponse).mockReturnValue(false)
    exhaust("group-stories", "user-3", RATE_LIMITS.groupStories)
    const res = await groupStoriesGET(req() as never)
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBeTruthy()
  })
})

/**
 * RAD-326 — EventSource exposes neither the status nor the headers of a
 * response, so a bare 429 reached the UI as "the connection was interrupted".
 * A caller that asks for an event stream (EventSource always sends
 * `Accept: text/event-stream`) gets the refusal as one well-formed SSE `error`
 * frame instead: same single request, same bucket, nothing counted twice.
 * Every other caller keeps the real 429 (RAD-296, above).
 */
describe("SSE routes — a rate-limited EventSource can read why (RAD-326)", () => {
  const sseReq = (path: string) =>
    new Request(`http://localhost${path}`, { headers: { accept: "text/event-stream" } })

  async function readFrame(res: Response) {
    const text = await res.text()
    const data = text
      .split("\n")
      .find(line => line.startsWith("data: "))
    return { text, data: data ? JSON.parse(data.slice("data: ".length)) : null }
  }

  async function expectRateLimitFrame(res: Response) {
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    // A refusal must never be cached past its window, by the edge or the browser.
    expect(res.headers.get("cache-control")).toBe("no-store")
    const retryAfter = Number(res.headers.get("Retry-After"))
    expect(retryAfter).toBeGreaterThan(0)

    const { text, data } = await readFrame(res)
    expect(data).toEqual({
      type: "error",
      code: "RATE_LIMITED",
      retryAfter,
      message: `Too many requests — try again in ${retryAfter}s`,
      error: `Too many requests — try again in ${retryAfter}s`,
    })
    // A consumer that forgets to close still waits the window out before the
    // browser's own reconnect.
    expect(text).toMatch(new RegExp(`^retry: ${retryAfter * 1000}$`, "m"))
  }

  it("parse-stream answers an event-stream caller with an in-band RATE_LIMITED frame", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1", role: "USER" } } as never)
    exhaust("parse-stream", "user-1", RATE_LIMITS.parseStream)
    await expectRateLimitFrame(await parseStreamGET(sseReq("/api/parse-stream?sourceIds=a") as never))
  })

  it("refilter answers an event-stream caller with an in-band RATE_LIMITED frame", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-2", role: "USER" })
    vi.mocked(isErrorResponse).mockReturnValue(false)
    exhaust("refilter", "user-2", RATE_LIMITS.refilter)
    await expectRateLimitFrame(await refilterGET(sseReq("/api/posts/refilter") as never))
  })

  it("group-stories answers an event-stream caller with an in-band RATE_LIMITED frame", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-3", role: "USER" })
    vi.mocked(isErrorResponse).mockReturnValue(false)
    exhaust("group-stories", "user-3", RATE_LIMITS.groupStories)
    await expectRateLimitFrame(await groupStoriesGET(sseReq("/api/posts/group-stories") as never))
  })

  it("a refused stream request starts no work", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-4", role: "USER" })
    vi.mocked(isErrorResponse).mockReturnValue(false)
    exhaust("refilter", "user-4", RATE_LIMITS.refilter)
    vi.mocked(requireVerifiedEmail).mockClear()
    vi.mocked(db.user.findUnique).mockClear()
    await expectRateLimitFrame(await refilterGET(sseReq("/api/posts/refilter") as never))
    // The refusal returns before the email gate and before any DB read.
    expect(requireVerifiedEmail).not.toHaveBeenCalled()
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  it("keeps the real 429 for a caller that did not ask for an event stream", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-5", role: "USER" } } as never)
    exhaust("parse-stream", "user-5", RATE_LIMITS.parseStream)
    const res = await parseStreamGET(
      new Request("http://localhost/api/parse-stream", { headers: { accept: "application/json" } }) as never
    )
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe("RATE_LIMITED")
  })
})
