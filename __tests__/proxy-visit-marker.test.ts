/**
 * RAD-168 — the proxy keeps a sliding visit marker and tells the page whether
 * the request starts a new visit.
 *
 * A new visit is the first full page load after an hour with no Radaric
 * activity. Only a document navigation (`Sec-Fetch-Mode: navigate`, or absent)
 * to a non-/api path can start one: it is the only request that creates the
 * marker or carries the new-visit verdict. Background traffic — /api polls,
 * session refreshes on focus, RSC fetches and Link prefetches — only extends a
 * marker that is already there and belongs to this user; it never creates one,
 * so it cannot spend the verdict before the page load that should see it.
 *
 * The marker value is a short hash of the user id, so another account signing
 * in on the same browser does not inherit it. The page cannot read the cookie
 * itself: Next merges cookies set by the proxy into the same request's
 * `cookies()`, so the proxy forwards its verdict as a request header.
 *
 *   AC-1  page load, no marker → new-visit header + marker (Max-Age=3600; HttpOnly; SameSite=Lax; Path=/)
 *   AC-2  Secure follows the request protocol: https → Secure, http (self-host) → none
 *   AC-3  page load with this user's marker → no header, marker refreshed
 *   AC-4  page load with another user's marker → new visit, marker overwritten
 *   AC-5  /api request: no marker → nothing; this user's marker → refreshed; another user's → nothing
 *   AC-6  RSC / prefetch (cors, same-origin): no marker → nothing; this user's marker → refreshed
 *   AC-7  a client-sent new-visit header is stripped on a continuing visit and normalised to "1" on a new one
 *   AC-8  signed-out and public requests get no marker; the proxy's own redirects set none
 *   AC-9  the marker is a 16-hex-char hash, never the raw user id
 */

import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({
  auth: (handler: unknown) => handler,
}))

import proxyDefault from "@/proxy"
import { NEW_VISIT_HEADER, VISIT_COOKIE, visitMarker } from "@/lib/visit-marker"

type Session = { user: { id: string } } | null
const proxy = proxyDefault as unknown as (req: NextRequest) => Promise<Response> | Response

const HTTPS = "https://radaric.pro"
const USER = { user: { id: "user-a" } }

async function run(url: string, headers: Record<string, string>, session: Session) {
  const req = new NextRequest(url.startsWith("http") ? url : `${HTTPS}${url}`, { headers })
  Object.assign(req, { auth: session })
  return await proxy(req)
}

async function withMarker(userId: string, extra: Record<string, string> = {}) {
  return { cookie: `${VISIT_COOKIE}=${await visitMarker(userId)}`, ...extra }
}

function visitCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${VISIT_COOKIE}=`))
}

// NextResponse.next({ request: { headers } }) encodes the overridden request
// headers on the response as x-middleware-request-<name>.
function forwardedNewVisit(res: Response): string | null {
  return res.headers.get(`x-middleware-request-${NEW_VISIT_HEADER}`)
}

describe("RAD-168 — proxy visit marker", () => {
  it.each([["navigate", { "sec-fetch-mode": "navigate" }], ["no Sec-Fetch-Mode", {}]])(
    "AC-1: a page load (%s) without a marker starts a new visit and creates the marker",
    async (_label, headers) => {
      const res = await run("/posts", headers, USER)

      expect(res.headers.get("location")).toBe(null)
      expect(forwardedNewVisit(res)).toBe("1")
      const cookie = visitCookie(res)
      expect(cookie).toContain(`${VISIT_COOKIE}=${await visitMarker("user-a")}`)
      expect(cookie).toMatch(/Max-Age=3600/i)
      expect(cookie).toMatch(/HttpOnly/i)
      expect(cookie).toMatch(/SameSite=Lax/i)
      expect(cookie).toMatch(/Path=\//i)
    },
  )

  it("AC-2: over https the marker is Secure", async () => {
    const res = await run("https://radaric.pro/posts", { "sec-fetch-mode": "navigate" }, USER)

    expect(visitCookie(res)).toMatch(/;\s*Secure/i)
  })

  it("AC-2: over plain http (self-host) the marker is not Secure, so the browser keeps it", async () => {
    const res = await run("http://radaric.local:3000/posts", { "sec-fetch-mode": "navigate" }, USER)

    expect(visitCookie(res)).toBeDefined()
    expect(visitCookie(res)).not.toMatch(/Secure/i)
  })

  it("AC-3: a page load carrying this user's marker continues the visit and refreshes the marker", async () => {
    const res = await run("/posts", await withMarker("user-a", { "sec-fetch-mode": "navigate" }), USER)

    expect(forwardedNewVisit(res)).toBe(null)
    expect(visitCookie(res)).toContain(`${VISIT_COOKIE}=${await visitMarker("user-a")}`)
  })

  it("AC-4: a page load carrying another user's marker starts a new visit and overwrites it", async () => {
    const res = await run("/posts", await withMarker("user-b", { "sec-fetch-mode": "navigate" }), USER)

    expect(forwardedNewVisit(res)).toBe("1")
    expect(visitCookie(res)).toContain(`${VISIT_COOKIE}=${await visitMarker("user-a")}`)
  })

  it("AC-5: an /api request without a marker sets nothing", async () => {
    const res = await run("/api/stats", {}, USER)

    expect(visitCookie(res)).toBeUndefined()
    expect(forwardedNewVisit(res)).toBe(null)
  })

  it("AC-5: an /api request with this user's marker refreshes it", async () => {
    const res = await run("/api/auth/session", await withMarker("user-a", { "sec-fetch-mode": "cors" }), USER)

    expect(forwardedNewVisit(res)).toBe(null)
    const cookie = visitCookie(res)
    expect(cookie).toContain(`${VISIT_COOKIE}=${await visitMarker("user-a")}`)
    expect(cookie).toMatch(/Max-Age=3600/i)
  })

  it("AC-5: an /api request with another user's marker sets nothing", async () => {
    const res = await run("/api/stats", await withMarker("user-b"), USER)

    expect(visitCookie(res)).toBeUndefined()
    expect(forwardedNewVisit(res)).toBe(null)
  })

  it.each(["cors", "same-origin"])("AC-6: an RSC/prefetch request (%s) without a marker sets nothing", async (mode) => {
    const res = await run("/posts", { "sec-fetch-mode": mode }, USER)

    expect(visitCookie(res)).toBeUndefined()
    expect(forwardedNewVisit(res)).toBe(null)
  })

  it("AC-6: an RSC request with this user's marker refreshes it", async () => {
    const res = await run("/feeds", await withMarker("user-a", { "sec-fetch-mode": "cors" }), USER)

    expect(forwardedNewVisit(res)).toBe(null)
    expect(visitCookie(res)).toContain(`${VISIT_COOKIE}=${await visitMarker("user-a")}`)
  })

  it("AC-7: a forged new-visit header on a page load with a valid marker is stripped", async () => {
    const res = await run("/posts", await withMarker("user-a", { "sec-fetch-mode": "navigate", [NEW_VISIT_HEADER]: "1" }), USER)

    // Overridden request headers that are absent from the forwarded set are deleted.
    expect(forwardedNewVisit(res)).toBe(null)
    const overridden = (res.headers.get("x-middleware-override-headers") ?? "").split(",")
    expect(overridden).not.toContain(NEW_VISIT_HEADER)
  })

  it("AC-7: a forged header on a new visit is replaced by exactly \"1\"", async () => {
    const res = await run("/posts", { "sec-fetch-mode": "navigate", [NEW_VISIT_HEADER]: "forged, 1" }, USER)

    expect(forwardedNewVisit(res)).toBe("1")
  })

  it("AC-7: a forged header on background traffic is stripped", async () => {
    const res = await run("/api/stats", { [NEW_VISIT_HEADER]: "1" }, USER)

    expect(forwardedNewVisit(res)).toBe(null)
  })

  it("AC-8: a signed-out public request gets no marker", async () => {
    const res = await run("/terms", { "sec-fetch-mode": "navigate" }, null)

    expect(visitCookie(res)).toBeUndefined()
  })

  it("AC-8: a signed-out protected request is redirected without a marker", async () => {
    const res = await run("/posts", { "sec-fetch-mode": "navigate" }, null)

    expect(res.headers.get("location")).not.toBe(null)
    expect(visitCookie(res)).toBeUndefined()
  })

  it("AC-8: the signed-in / → /posts redirect sets no marker, so /posts still sees the new visit", async () => {
    const res = await run("/", { "sec-fetch-mode": "navigate" }, USER)

    expect(new URL(res.headers.get("location") as string).pathname).toBe("/posts")
    expect(visitCookie(res)).toBeUndefined()
  })

  it("AC-9: the marker is a 16-hex-char hash, stable per user and distinct across users", async () => {
    const a = await visitMarker("user-a")

    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toContain("user-a")
    expect(await visitMarker("user-a")).toBe(a)
    expect(await visitMarker("user-b")).not.toBe(a)
  })
})
