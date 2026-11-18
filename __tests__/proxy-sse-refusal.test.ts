/**
 * RAD-406 — a signed-out EventSource never reaches the SSE routes.
 *
 * proxy.ts answers every unauthenticated non-public request with a 307 to
 * /signup, and `/api/*` is not public. EventSource follows that redirect, gets
 * an HTML document, and fails the connection without exposing why — so an
 * expired session read as "The connection was interrupted" before the route's
 * own 401 could ever run. The proxy is therefore the layer that answers a
 * signed-out `/api/*` event-stream request: one in-band UNAUTHORIZED frame, the
 * same one the routes send, and no redirect at all (a redirect is what made
 * the request unreadable, and RAD-304's tagging exists only because redirects
 * of programmatic fetches poison the CDN cache).
 *
 *   AC-1  signed-out /api/parse-stream with Accept: text/event-stream → 200 SSE, one UNAUTHORIZED frame, no Location
 *   AC-2  the same for /api/posts/refilter and /api/posts/group-stories
 *   AC-3  a signed-out /api/* JSON caller keeps the existing 307 → /signup (+ _rsc for a fetch, RAD-304)
 *   AC-4  a signed-out document or RSC request for a page keeps the existing redirect, even if it accepts event streams
 *   AC-5  a signed-in event-stream request passes through to the route
 *   AC-6  a public /api path is passed through untouched for an event-stream caller
 */

import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({
  auth: (handler: unknown) => handler,
}))

import proxyDefault from "@/proxy"
import { refusalCopy, UNAUTHORIZED } from "@/lib/stream-refusal"

type Session = { user: { id: string } } | null
const proxy = proxyDefault as unknown as (req: NextRequest) => Promise<Response> | Response

const ORIGIN = "https://radaric.pro"
/** What a browser's EventSource sends for a same-origin stream. */
const EVENT_SOURCE = { accept: "text/event-stream", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }

async function run(path: string, headers: Record<string, string>, session: Session) {
  const req = new NextRequest(`${ORIGIN}${path}`, { headers })
  Object.assign(req, { auth: session })
  return await proxy(req)
}

describe("RAD-406 — the proxy answers a signed-out EventSource in-band", () => {
  it.each(["/api/parse-stream?sourceIds=a", "/api/posts/refilter", "/api/posts/group-stories?feedId=f"])(
    "AC-1/2: signed-out %s gets one UNAUTHORIZED frame instead of a redirect",
    async path => {
      const res = await run(path, EVENT_SOURCE, null)

      expect(res.status).toBe(200)
      expect(res.headers.get("location")).toBeNull()
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      expect(res.headers.get("cache-control")).toBe("no-store")
      const text = await res.text()
      const frames = text.split("\n").filter(line => line.startsWith("data: "))
      expect(frames).toHaveLength(1)
      const copy = refusalCopy({ code: UNAUTHORIZED })
      expect(JSON.parse(frames[0].slice("data: ".length))).toEqual({
        type: "error",
        code: UNAUTHORIZED,
        message: copy,
        error: copy,
      })
    }
  )

  it("AC-3: a signed-out /api JSON caller keeps the tagged 307 to /signup", async () => {
    const res = await run("/api/parse-stream", { accept: "application/json", "sec-fetch-mode": "cors" }, null)

    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get("location") as string)
    expect(loc.pathname).toBe("/signup")
    expect(loc.searchParams.get("_rsc")).toBeTruthy()
  })

  it("AC-4: a signed-out page request keeps its redirect whatever it accepts", async () => {
    const nav = await run("/posts", { accept: "text/event-stream,text/html", "sec-fetch-mode": "navigate" }, null)
    expect(nav.status).toBe(307)
    expect(new URL(nav.headers.get("location") as string).pathname).toBe("/signup")

    const rsc = await run("/posts", { accept: "*/*", "sec-fetch-mode": "cors" }, null)
    expect(rsc.status).toBe(307)
    expect(new URL(rsc.headers.get("location") as string).searchParams.get("_rsc")).toBeTruthy()
  })

  it("AC-5: a signed-in event-stream request passes through to the route", async () => {
    const res = await run("/api/parse-stream?sourceIds=a", EVENT_SOURCE, { user: { id: "u1" } })

    expect(res.headers.get("location")).toBeNull()
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("AC-6: a public /api path is not refused for an event-stream caller", async () => {
    const res = await run("/api/health", EVENT_SOURCE, null)

    expect(res.headers.get("location")).toBeNull()
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })
})
