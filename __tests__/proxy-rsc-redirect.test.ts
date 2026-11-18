/**
 * RAD-304 — RSC redirect cache-key poisoning (RED phase)
 *
 * Next strips the `_rsc` cache-busting param and the RSC flight headers before
 * proxy.ts runs, so a redirect issued for an RSC fetch points at the CLEAN
 * document URL. The browser follows it with RSC headers, gets a
 * `text/x-component` body, and the CDN (Vary stripped, `max-age=0`) caches
 * that flight payload under the document URL. A later tab-restore navigation
 * then renders the cached RSC payload as the page.
 *
 * The proxy cannot see the RSC headers, but it CAN see `Sec-Fetch-Mode`:
 * `navigate` for document navigations, `cors` / `same-origin` / `no-cors` for
 * programmatic fetch() — which is what Next's RSC requests are.
 *
 * Spec coverage:
 *   AC-1  logged-in  GET /            + sec-fetch-mode: cors     → 307 → /posts       WITH non-empty _rsc, same-origin
 *   AC-2  logged-in  GET /            + sec-fetch-mode: navigate → 307 → /posts       WITHOUT _rsc
 *   AC-3  logged-out GET /posts       + sec-fetch-mode: cors     → 307 → /signup      WITH non-empty _rsc, same-origin
 *   AC-4  logged-out GET /posts       + no Sec-Fetch headers     → 307 → /signup      WITHOUT _rsc (legacy client)
 *   AC-5  logged-in  GET /materials/abc + sec-fetch-mode: cors   → 307 → /posts/abc   WITH non-empty _rsc — the 301 is
 *         downgraded: a browser caches a permanent redirect by request URL alone, so a marked 301 installed by a
 *         prefetch would later send a document navigation onto the marked URL
 *   AC-5b logged-in  GET /materials/abc + sec-fetch-mode: navigate → 301 → /posts/abc WITHOUT _rsc (permanent stays permanent)
 *   AC-6  logged-out GET /terms       (any Sec-Fetch-Mode)       → passthrough: 200, no Location
 *   AC-7  every non-navigate mode Next's fetch() can send (cors / same-origin / no-cors) is treated as programmatic
 *
 * Note: in production `/materials` and `/materials/:path*` never reach proxy.ts — `next.config.ts` `redirects()` run
 * first and answer 308 with the incoming query (so `_rsc`) preserved. The proxy branch is a belt for other prefixes;
 * AC-5/5b pin the helper's contract, not the live `/materials` path.
 */

import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// NextAuth's auth() wrapper is an identity function here, so the default export
// of proxy.ts is the bare handler and we can call it directly.
vi.mock("@/lib/auth", () => ({
  auth: (handler: unknown) => handler,
}))

import proxyDefault from "@/proxy"

type Session = { user: { id: string } } | null
const proxy = proxyDefault as unknown as (req: NextRequest) => Promise<Response> | Response

const LOGGED_IN: Session = { user: { id: "u1" } }
const LOGGED_OUT: Session = null

const ORIGIN = "https://radaric.pro"

async function run(url: string, headers: Record<string, string>, session: Session) {
  const req = new NextRequest(url, { headers })
  Object.assign(req, { auth: session })
  return await proxy(req)
}

function location(res: Response): URL {
  const raw = res.headers.get("location")
  expect(raw).not.toBe(null)
  return new URL(raw as string)
}

describe("RAD-304 — proxy redirects must carry _rsc for RSC fetches", () => {
  it("AC-1: logged-in RSC fetch of / redirects to /posts with a non-empty _rsc param", async () => {
    const res = await run(`${ORIGIN}/`, { "sec-fetch-mode": "cors" }, LOGGED_IN)

    expect(res.status).toBe(307)
    const loc = location(res)
    expect(loc.origin).toBe(ORIGIN)
    expect(loc.pathname).toBe("/posts")
    expect(loc.searchParams.get("_rsc")).toBeTruthy()
  })

  it("AC-2: logged-in document navigation to / redirects to the clean /posts URL", async () => {
    const res = await run(`${ORIGIN}/`, { "sec-fetch-mode": "navigate" }, LOGGED_IN)

    expect(res.status).toBe(307)
    const loc = location(res)
    expect(loc.origin).toBe(ORIGIN)
    expect(loc.pathname).toBe("/posts")
    expect(loc.searchParams.has("_rsc")).toBe(false)
    expect(loc.search).toBe("")
  })

  it("AC-3: logged-out RSC fetch of /posts redirects to /signup with a non-empty _rsc param", async () => {
    const res = await run(`${ORIGIN}/posts`, { "sec-fetch-mode": "cors" }, LOGGED_OUT)

    expect(res.status).toBe(307)
    const loc = location(res)
    expect(loc.origin).toBe(ORIGIN)
    expect(loc.pathname).toBe("/signup")
    expect(loc.searchParams.get("_rsc")).toBeTruthy()
  })

  // Accepted residual: a client that sends no Sec-Fetch-* headers (Safari < 16.4, curl) is indistinguishable
  // from a document navigation, so it keeps the pre-fix behaviour and the original bug can still occur there.
  it("AC-4: logged-out request with no Sec-Fetch headers redirects to the clean /signup URL", async () => {
    const res = await run(`${ORIGIN}/posts`, {}, LOGGED_OUT)

    expect(res.status).toBe(307)
    const loc = location(res)
    expect(loc.origin).toBe(ORIGIN)
    expect(loc.pathname).toBe("/signup")
    expect(loc.searchParams.has("_rsc")).toBe(false)
    expect(loc.search).toBe("")
  })

  it("AC-5: logged-in RSC fetch of /materials/abc is downgraded to a 307 to /posts/abc with a non-empty _rsc param", async () => {
    const res = await run(`${ORIGIN}/materials/abc`, { "sec-fetch-mode": "cors" }, LOGGED_IN)

    expect(res.status).toBe(307)
    const loc = location(res)
    expect(loc.origin).toBe(ORIGIN)
    expect(loc.pathname).toBe("/posts/abc")
    expect(loc.searchParams.get("_rsc")).toBeTruthy()
  })

  it("AC-5b: logged-in document navigation to /materials/abc keeps the permanent 301 to the clean /posts/abc URL", async () => {
    const res = await run(`${ORIGIN}/materials/abc`, { "sec-fetch-mode": "navigate" }, LOGGED_IN)

    expect(res.status).toBe(301)
    const loc = location(res)
    expect(loc.origin).toBe(ORIGIN)
    expect(loc.pathname).toBe("/posts/abc")
    expect(loc.searchParams.has("_rsc")).toBe(false)
    expect(loc.search).toBe("")
  })

  it("AC-6: logged-out request for the public /terms path is passed through untouched", async () => {
    const res = await run(`${ORIGIN}/terms`, { "sec-fetch-mode": "cors" }, LOGGED_OUT)

    expect(res.status).toBe(200)
    expect(res.headers.get("location")).toBe(null)
  })

  it.each(["cors", "same-origin", "no-cors"])(
    "AC-7: logged-in fetch of / with sec-fetch-mode %s redirects to /posts with a non-empty _rsc param",
    async (mode) => {
      const res = await run(`${ORIGIN}/`, { "sec-fetch-mode": mode }, LOGGED_IN)

      expect(res.status).toBe(307)
      const loc = location(res)
      expect(loc.origin).toBe(ORIGIN)
      expect(loc.pathname).toBe("/posts")
      expect(loc.searchParams.get("_rsc")).toBeTruthy()
    },
  )
})
