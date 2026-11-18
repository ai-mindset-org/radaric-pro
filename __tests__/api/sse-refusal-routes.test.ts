// @vitest-environment node

/**
 * RAD-406 — every pre-stream refusal of the three SSE routes, as each kind of
 * caller sees it.
 *
 * EventSource exposes neither the status nor the body of a non-200 response, so
 * a 401 or a 403 EMAIL_NOT_VERIFIED reached the UI as a dropped connection — the
 * same blindness RAD-326 fixed for the 429. A caller that asks for an event
 * stream (`Accept: text/event-stream`, which EventSource always sends) now gets
 * every refusal as one in-band `error` frame with a stable `code`; every other
 * caller keeps the real status and the real body (RAD-296, RAD-297).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: vi.fn() } },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(() => false),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
}))

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { auth } from "@/lib/auth"
import { requireVerifiedEmail } from "@/lib/email-verification"
import { GET as parseStreamGET } from "@/app/api/parse-stream/route"
import { GET as refilterGET } from "@/app/api/posts/refilter/route"
import { GET as groupStoriesGET } from "@/app/api/posts/group-stories/route"
import { RATE_LIMITS, rateLimit, resetRateLimits } from "@/lib/rate-limit"
import { refusalCopy, UNAUTHORIZED, EMAIL_NOT_VERIFIED, RATE_LIMITED } from "@/lib/stream-refusal"

/** The exact 403 `requireVerifiedEmail` answers, so the JSON contract is the real one. */
const EMAIL_BODY = {
  error: "Verify your email address to use AI features. Check your inbox or resend the link.",
  code: "EMAIL_NOT_VERIFIED",
}

type Route = {
  name: "parse-stream" | "refilter" | "group-stories"
  path: string
  handler: (req: never) => Promise<Response>
  bucket: string
  limit: { limit: number; windowMs: number }
}

const ROUTES: Route[] = [
  { name: "parse-stream", path: "/api/parse-stream?sourceIds=a", handler: parseStreamGET as never, bucket: "parse-stream", limit: RATE_LIMITS.parseStream },
  { name: "refilter", path: "/api/posts/refilter", handler: refilterGET as never, bucket: "refilter", limit: RATE_LIMITS.refilter },
  { name: "group-stories", path: "/api/posts/group-stories", handler: groupStoriesGET as never, bucket: "group-stories", limit: RATE_LIMITS.groupStories },
]

const sseReq = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { accept: "text/event-stream" } })
const jsonReq = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { accept: "application/json" } })

function signIn(route: Route, userId: string) {
  // parse-stream reads the session itself; the other two go through requireAuth.
  if (route.name === "parse-stream") {
    vi.mocked(auth).mockResolvedValue({ user: { id: userId, role: "USER" } } as never)
  } else {
    vi.mocked(requireAuth).mockResolvedValue({ userId, role: "USER" })
    vi.mocked(isErrorResponse).mockReturnValue(false)
  }
}

function signOut(route: Route) {
  if (route.name === "parse-stream") {
    vi.mocked(auth).mockResolvedValue(null as never)
  } else {
    vi.mocked(requireAuth).mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    vi.mocked(isErrorResponse).mockReturnValue(true)
  }
}

function unverified() {
  vi.mocked(requireVerifiedEmail).mockResolvedValue(NextResponse.json(EMAIL_BODY, { status: 403 }))
}

async function readFrame(res: Response) {
  const text = await res.text()
  const frames = text.split("\n").filter(line => line.startsWith("data: "))
  return { text, frames: frames.map(line => JSON.parse(line.slice("data: ".length))) }
}

/** One well-formed frame, then the end of the response. */
async function expectRefusalFrame(res: Response, code: string) {
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  expect(res.headers.get("cache-control")).toBe("no-store")
  const { text, frames } = await readFrame(res)
  expect(frames).toHaveLength(1)
  const copy = refusalCopy({ code } as never)
  expect(frames[0]).toEqual({ type: "error", code, message: copy, error: copy })
  // A consumer that forgets to close must not reconnect in a tight loop.
  const retry = Number(/^retry: (\d+)$/m.exec(text)?.[1])
  expect(retry).toBeGreaterThanOrEqual(60_000)
  // No wait to advertise for a refusal that waiting cannot fix.
  expect(res.headers.get("Retry-After")).toBeNull()
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimits()
  vi.mocked(requireVerifiedEmail).mockResolvedValue(null)
})

describe.each(ROUTES)("$name — pre-stream refusals (RAD-406)", route => {
  it("answers a signed-out EventSource with an in-band UNAUTHORIZED frame", async () => {
    signOut(route)
    await expectRefusalFrame(await route.handler(sseReq(route.path) as never), UNAUTHORIZED)
  })

  it("keeps the real 401 and body for a caller that did not ask for an event stream", async () => {
    signOut(route)
    const res = await route.handler(jsonReq(route.path) as never)
    expect(res.status).toBe(401)
    expect(res.headers.get("content-type")).not.toContain("event-stream")
    expect(await res.json()).toEqual({ error: "Unauthorized" })
  })

  it("answers an unverified EventSource with an in-band EMAIL_NOT_VERIFIED frame, starting no work", async () => {
    signIn(route, `${route.name}-unverified`)
    unverified()
    await expectRefusalFrame(await route.handler(sseReq(route.path) as never), EMAIL_NOT_VERIFIED)
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  it("keeps the real 403 EMAIL_NOT_VERIFIED body for a caller that did not ask for an event stream", async () => {
    signIn(route, `${route.name}-unverified-json`)
    unverified()
    const res = await route.handler(jsonReq(route.path) as never)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(EMAIL_BODY)
  })

  it("still answers a rate-limited EventSource with RATE_LIMITED and its wait (RAD-326)", async () => {
    const userId = `${route.name}-limited`
    signIn(route, userId)
    for (let i = 0; i < route.limit.limit; i++) rateLimit(route.bucket, userId, route.limit.limit, route.limit.windowMs)
    const res = await route.handler(sseReq(route.path) as never)
    expect(res.status).toBe(200)
    const retryAfter = Number(res.headers.get("Retry-After"))
    expect(retryAfter).toBeGreaterThan(0)
    const { frames } = await readFrame(res)
    expect(frames[0]).toMatchObject({ type: "error", code: RATE_LIMITED, retryAfter })
  })
})
