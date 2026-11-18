/**
 * RAD-209 / RAD-393 / RAD-408 — sidebar state cookies, written by
 * POST /api/ui-state (app/api/ui-state/route.ts).
 *
 * The write moved from a server action to a route handler because a
 * cookie-setting server action refreshes the route (RAD-408). The cookie
 * contract the layout reads did not change:
 *   - sidebar-open: "1"/"0", httpOnly, sameSite=lax, path=/, maxAge ~ 1 year
 *   - folders-collapsed: JSON ids written, empty list deletes the cookie,
 *     same flags — the layout reads it server-side for a flicker-free paint.
 * Anything else is a 400, and the proxy keeps the route signed-in only.
 */

import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({
  auth: (handler: unknown) => handler,
}))

import { POST } from "@/app/api/ui-state/route"
import proxyDefault from "@/proxy"
import { MAX_COLLAPSED_FOLDERS } from "@/lib/ui-state"

const proxy = proxyDefault as unknown as (req: NextRequest) => Promise<Response> | Response

function post(body: unknown, contentType = "application/json", extra: Record<string, string> = {}) {
  return POST(
    new Request("https://radaric.pro/api/ui-state", {
      method: "POST",
      headers: { "Content-Type": contentType, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  )
}

/** Set-Cookie headers parsed into name, value and lower-cased attributes. */
function setCookies(res: Response) {
  return res.headers.getSetCookie().map((line) => {
    const [pair, ...attrs] = line.split(";").map((part) => part.trim())
    const eq = pair.indexOf("=")
    const attributes = new Map(
      attrs.map((attr) => {
        const [k, v = ""] = attr.split("=")
        return [k.toLowerCase(), v] as const
      })
    )
    return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attributes }
  })
}

function expectContractFlags(attributes: Map<string, string>) {
  expect(attributes.has("httponly")).toBe(true)
  expect(attributes.get("samesite")?.toLowerCase()).toBe("lax")
  expect(attributes.get("path")).toBe("/")
  // Max-age should be roughly one year; guard against accidental regressions to 0
  const maxAge = Number(attributes.get("max-age"))
  expect(maxAge).toBeGreaterThan(60 * 60 * 24 * 300)
  expect(maxAge).toBeLessThanOrEqual(60 * 60 * 24 * 366)
}

describe("POST /api/ui-state — sidebar-open", () => {
  it("writes sidebar-open=1 when open is true", async () => {
    const res = await post({ sidebarOpen: true })
    expect(res.status).toBe(204)
    const cookies = setCookies(res)
    expect(cookies).toHaveLength(1)
    expect(cookies[0].name).toBe("sidebar-open")
    expect(cookies[0].value).toBe("1")
  })

  it("writes sidebar-open=0 when open is false", async () => {
    const [cookie] = setCookies(await post({ sidebarOpen: false }))
    expect(cookie.name).toBe("sidebar-open")
    expect(cookie.value).toBe("0")
  })

  it("sets httpOnly, sameSite=lax, path=/, maxAge ~= 1 year", async () => {
    const [cookie] = setCookies(await post({ sidebarOpen: true }))
    expectContractFlags(cookie.attributes)
  })
})

describe("POST /api/ui-state — folders-collapsed", () => {
  it("stores the collapsed folder ids as JSON with the same flags", async () => {
    const res = await post({ collapsedFolders: ["folder-1", "cmg8x2k0b0001l70f4q9z8d1e"] })
    expect(res.status).toBe(204)
    const cookies = setCookies(res)
    expect(cookies).toHaveLength(1)
    expect(cookies[0].name).toBe("folders-collapsed")
    expect(JSON.parse(cookies[0].value)).toEqual(["folder-1", "cmg8x2k0b0001l70f4q9z8d1e"])
    expectContractFlags(cookies[0].attributes)
  })

  it("deletes the cookie at path=/ when nothing is collapsed (default is expanded)", async () => {
    const [cookie] = setCookies(await post({ collapsedFolders: [] }))
    expect(cookie.name).toBe("folders-collapsed")
    expect(cookie.value).toBe("")
    // Without an explicit path the delete would be scoped to /api and miss the cookie.
    expect(cookie.attributes.get("path")).toBe("/")
    const expires = cookie.attributes.get("expires")
    expect(expires && new Date(expires).getTime()).toBeLessThan(Date.now())
  })

  it("writes both cookies when both are sent", async () => {
    const names = setCookies(await post({ sidebarOpen: false, collapsedFolders: ["folder-1"] })).map((c) => c.name)
    expect(names.sort()).toEqual(["folders-collapsed", "sidebar-open"])
  })

  it(`accepts up to ${MAX_COLLAPSED_FOLDERS} ids`, async () => {
    const ids = Array.from({ length: MAX_COLLAPSED_FOLDERS }, (_, i) => `cmg8x2k0b${String(i).padStart(4, "0")}l70f4q9z8d1e`)
    const res = await post({ collapsedFolders: ids })
    expect(res.status).toBe(204)
    // The whole header fits the 4 KB a browser keeps per cookie.
    expect(res.headers.getSetCookie()[0].length).toBeLessThan(4096)
  })
})

describe("POST /api/ui-state — strict input", () => {
  const bad: Array<[string, unknown]> = [
    ["an empty object", {}],
    ["a non-boolean sidebarOpen", { sidebarOpen: "0" }],
    ["a null sidebarOpen", { sidebarOpen: null }],
    ["collapsedFolders that is not an array", { collapsedFolders: "folder-1" }],
    ["a non-string folder id", { collapsedFolders: [1] }],
    ["an empty folder id", { collapsedFolders: [""] }],
    ["a folder id with cookie syntax in it", { collapsedFolders: ['a";b'] }],
    ["a folder id longer than 32 characters", { collapsedFolders: ["x".repeat(33)] }],
    [`more than ${MAX_COLLAPSED_FOLDERS} folder ids`, { collapsedFolders: Array.from({ length: MAX_COLLAPSED_FOLDERS + 1 }, (_, i) => `f${i}`) }],
    ["an unknown key", { sidebarOpen: true, theme: "dark" }],
    ["an array body", [true]],
    ["a bare boolean", true],
  ]

  it.each(bad)("rejects %s with a 400 and sets no cookie", async (_label, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it("rejects malformed JSON with a 400", async () => {
    const res = await post("{not json")
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it("rejects a non-JSON content type (a cross-site form post) with a 400", async () => {
    const res = await post(JSON.stringify({ sidebarOpen: false }), "text/plain")
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it("rejects a safelisted type that only mentions JSON in a parameter", async () => {
    const res = await post(JSON.stringify({ sidebarOpen: false }), "text/plain; charset=application/json")
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it("accepts JSON with a charset parameter", async () => {
    const res = await post({ sidebarOpen: false }, "application/json; charset=utf-8")
    expect(res.status).toBe(204)
  })

  it("refuses a cross-site request with a 403", async () => {
    const res = await post({ sidebarOpen: false }, "application/json", { "Sec-Fetch-Site": "cross-site" })
    expect(res.status).toBe(403)
    expect(res.headers.getSetCookie()).toEqual([])
  })
})

describe("proxy — /api/ui-state is signed-in only", () => {
  function proxied(session: { user: { id: string } } | null) {
    const req = new NextRequest("https://radaric.pro/api/ui-state", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Mode": "cors" },
      body: JSON.stringify({ sidebarOpen: false }),
    })
    ;(req as unknown as { auth: unknown }).auth = session
    return proxy(req)
  }

  it("lets a signed-in user's request through to the handler", async () => {
    const res = await proxied({ user: { id: "user-1" } })
    expect(res.headers.get("x-middleware-next")).toBe("1")
    expect(res.headers.get("location")).toBeNull()
  })

  it("redirects a signed-out request away instead of writing anything", async () => {
    const res = await proxied(null)
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/signup")
  })
})
