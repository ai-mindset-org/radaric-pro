/**
 * RAD-392 — safeFetch drops credentials when a redirect crosses origins.
 *
 * safeFetch follows redirects itself (`redirect: "manual"`), so it — not the
 * platform — decides which headers each hop carries. `Cookie` and
 * `Authorization` belong to the origin they were issued for; once a hop leaves
 * that origin they are dropped for the rest of the chain. Other headers
 * (User-Agent) keep flowing.
 *
 * Coverage:
 *   9.  cross-origin hop drops Cookie + Authorization, keeps User-Agent
 *   10. header names are matched case-insensitively
 *   11. same-origin hop keeps all three headers
 *   12. once dropped, credentials stay dropped (a → b → a)
 *   13. Proxy-Authorization is dropped too
 *   14. no headers at all → the chain is still followed, nothing sent
 *   15. https → http on the same host is a different origin
 *   16. each redirect's body is released before the next hop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { safeFetch } from "@/lib/url-validation"

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type FetchInit = { headers?: HeadersInit } | undefined

function okResponse(url: string): Response {
  return { ok: true, status: 200, url, headers: new Headers(), text: async () => "ok" } as unknown as Response
}

function redirectResponse(url: string, location: string, status = 302): Response {
  return { ok: false, status, url, headers: new Headers({ location }), text: async () => "" } as unknown as Response
}

function routes(table: Record<string, (url: string) => Response>) {
  return async (input: unknown) => {
    const url = String(input)
    const handler = table[url]
    if (handler) return handler(url)
    return { ok: false, status: 404, url, headers: new Headers(), text: async () => "" } as unknown as Response
  }
}

function headersOf(call: number): Headers {
  return new Headers((mockFetch.mock.calls[call]?.[1] as FetchInit)?.headers)
}

describe("safeFetch — credentials on redirect hops (RAD-392)", () => {
  it("AC-9: a cross-origin hop drops Cookie and Authorization but keeps User-Agent", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://a.example.test/x": (u) => redirectResponse(u, "https://b.example.test/y"),
        "https://b.example.test/y": (u) => okResponse(u),
      })
    )

    const res = await safeFetch("https://a.example.test/x", {
      headers: { Cookie: "k=v", Authorization: "Bearer t", "User-Agent": "UA" },
    })

    expect(res?.status).toBe(200)
    expect(mockFetch.mock.calls.map(([u]) => String(u))).toEqual([
      "https://a.example.test/x",
      "https://b.example.test/y",
    ])
    expect(headersOf(0).get("cookie")).toBe("k=v")
    expect(headersOf(1).get("cookie")).toBeNull()
    expect(headersOf(1).get("authorization")).toBeNull()
    expect(headersOf(1).get("user-agent")).toBe("UA")
  })

  it("AC-10: matches credential header names case-insensitively", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://a10.example.test/x": (u) => redirectResponse(u, "https://b10.example.test/y"),
        "https://b10.example.test/y": (u) => okResponse(u),
      })
    )

    await safeFetch("https://a10.example.test/x", {
      headers: { cookie: "k=v", authorization: "Bearer t", "user-agent": "UA" },
    })

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(headersOf(1).get("cookie")).toBeNull()
    expect(headersOf(1).get("authorization")).toBeNull()
    expect(headersOf(1).get("user-agent")).toBe("UA")
  })

  it("AC-11: a same-origin hop keeps Cookie, Authorization and User-Agent", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://a11.example.test/x": (u) => redirectResponse(u, "https://a11.example.test/y"),
        "https://a11.example.test/y": (u) => okResponse(u),
      })
    )

    await safeFetch("https://a11.example.test/x", {
      headers: { Cookie: "k=v", Authorization: "Bearer t", "User-Agent": "UA" },
    })

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(headersOf(1).get("cookie")).toBe("k=v")
    expect(headersOf(1).get("authorization")).toBe("Bearer t")
    expect(headersOf(1).get("user-agent")).toBe("UA")
  })

  it("AC-12: once dropped, credentials stay dropped even when the chain returns to the original origin", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://a12.example.test/x": (u) => redirectResponse(u, "https://b12.example.test/y"),
        "https://b12.example.test/y": (u) => redirectResponse(u, "https://a12.example.test/z"),
        "https://a12.example.test/z": (u) => okResponse(u),
      })
    )

    await safeFetch("https://a12.example.test/x", {
      headers: { Cookie: "k=v", Authorization: "Bearer t", "User-Agent": "UA" },
    })

    expect(mockFetch.mock.calls.map(([u]) => String(u))).toEqual([
      "https://a12.example.test/x",
      "https://b12.example.test/y",
      "https://a12.example.test/z",
    ])
    expect(headersOf(2).get("cookie")).toBeNull()
    expect(headersOf(2).get("authorization")).toBeNull()
    expect(headersOf(2).get("user-agent")).toBe("UA")
  })

  it("AC-13: a cross-origin hop drops Proxy-Authorization too", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://a13.example.test/x": (u) => redirectResponse(u, "https://b13.example.test/y"),
        "https://b13.example.test/y": (u) => okResponse(u),
      })
    )

    await safeFetch("https://a13.example.test/x", {
      headers: { "Proxy-Authorization": "Basic p", "User-Agent": "UA" },
    })

    expect(headersOf(0).get("proxy-authorization")).toBe("Basic p")
    expect(headersOf(1).get("proxy-authorization")).toBeNull()
    expect(headersOf(1).get("user-agent")).toBe("UA")
  })

  it("AC-14: with no headers given, a cross-origin chain is followed and sends none", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://a14.example.test/x": (u) => redirectResponse(u, "https://b14.example.test/y"),
        "https://b14.example.test/y": (u) => okResponse(u),
      })
    )

    const res = await safeFetch("https://a14.example.test/x")

    expect(res?.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect([...headersOf(1).keys()]).toEqual([])
  })

  it("AC-15: a downgrade from https to http on the same host counts as another origin", async () => {
    mockFetch.mockImplementation(
      routes({
        "https://a15.example.test/x": (u) => redirectResponse(u, "http://a15.example.test/y"),
        "http://a15.example.test/y": (u) => okResponse(u),
      })
    )

    await safeFetch("https://a15.example.test/x", { headers: { Cookie: "k=v", "User-Agent": "UA" } })

    expect(String(mockFetch.mock.calls[1]?.[0])).toBe("http://a15.example.test/y")
    expect(headersOf(1).get("cookie")).toBeNull()
    expect(headersOf(1).get("user-agent")).toBe("UA")
  })
})

describe("safeFetch — redirect bodies (RAD-392)", () => {
  it("AC-16: releases each redirect response's body before following it", async () => {
    const cancel = vi.fn(async () => {})
    mockFetch.mockImplementation(
      routes({
        "https://a16.example.test/x": (u) =>
          ({ ...redirectResponse(u, "https://a16.example.test/y"), body: { cancel } }) as unknown as Response,
        "https://a16.example.test/y": (u) => okResponse(u),
      })
    )

    const res = await safeFetch("https://a16.example.test/x")

    expect(res?.status).toBe(200)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
