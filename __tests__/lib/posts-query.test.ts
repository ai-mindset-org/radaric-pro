/**
 * RAD-318 — how a `/api/posts` request is built.
 *
 * The module is the request builder and nothing else; the query's lifecycle
 * (which response is still wanted, when to page) lives in `MaterialsList`,
 * where the screen's hybrid SSR-then-top-up behaviour actually is. What is
 * pinned here is the property the builder exists for: a scope cannot be
 * forgotten at one call site, because there is only one.
 */

import { describe, it, expect } from "vitest"
import {
  buildPostsUrl,
  sameQuery,
  emptyQuery,
  isAllTypes,
  PAGE_SIZE,
} from "@/lib/materials/posts-query"

const parse = (url: string) => new URL(url, "http://localhost").searchParams

describe("request builder", () => {
  it("always carries sourceId on a source page", () => {
    const p = parse(buildPostsUrl(emptyQuery({ sourceId: "feed-a" }), 0))
    expect(p.get("sourceId")).toBe("feed-a")
  })

  it("never sends sourceId on the global view", () => {
    expect(parse(buildPostsUrl(emptyQuery(), 0)).has("sourceId")).toBe(false)
  })

  it("omits the type restriction when all types are selected", () => {
    expect(parse(buildPostsUrl(emptyQuery({ sourceTypes: ["ALL"] }), 0)).has("sourceType")).toBe(false)
    expect(parse(buildPostsUrl(emptyQuery({ sourceTypes: [] }), 0)).has("sourceType")).toBe(false)
  })

  it("joins several types with OR semantics on one parameter", () => {
    const p = parse(buildPostsUrl(emptyQuery({ sourceTypes: ["RSS", "TELEGRAM"] }), 0))
    expect(p.get("sourceType")).toBe("RSS,TELEGRAM")
  })

  it("combines view, types, source and search on one request", () => {
    const p = parse(
      buildPostsUrl(
        { filter: "FILTERED", sourceTypes: ["YOUTUBE"], sourceId: "feed-b", search: "  design systems  " },
        192
      )
    )
    expect(Object.fromEntries(p)).toEqual({
      filter: "FILTERED",
      limit: String(PAGE_SIZE),
      offset: "192",
      sourceType: "YOUTUBE",
      sourceId: "feed-b",
      search: "design systems",
    })
  })

  it("drops a whitespace-only search rather than querying for it", () => {
    expect(parse(buildPostsUrl(emptyQuery({ search: "   " }), 0)).has("search")).toBe(false)
  })
})

describe("query identity", () => {
  it("treats [] and ['ALL'] as the same unrestricted selection", () => {
    expect(isAllTypes([])).toBe(true)
    expect(sameQuery(emptyQuery({ sourceTypes: [] }), emptyQuery({ sourceTypes: ["ALL"] }))).toBe(true)
  })

  it("ignores the order types were checked in", () => {
    expect(
      sameQuery(emptyQuery({ sourceTypes: ["RSS", "X"] }), emptyQuery({ sourceTypes: ["X", "RSS"] }))
    ).toBe(true)
  })

  it("separates queries that differ in any dimension", () => {
    const base = emptyQuery()
    expect(sameQuery(base, emptyQuery({ filter: "ARCHIVED" }))).toBe(false)
    expect(sameQuery(base, emptyQuery({ sourceId: "feed-a" }))).toBe(false)
    expect(sameQuery(base, emptyQuery({ search: "x" }))).toBe(false)
    expect(sameQuery(base, emptyQuery({ sourceTypes: ["RSS"] }))).toBe(false)
  })
})
