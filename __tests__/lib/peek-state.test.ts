/**
 * RAD-345 — peek URL state.
 *
 * The pure half of "the URL is the state": precedence, idempotence and
 * preservation of unrelated params. The DOM wiring that applies these is
 * covered by the materials-list peek tests and the real-browser pass.
 */
import { describe, expect, it } from "vitest"
import {
  parsePeek,
  peekHref,
  peekSearch,
  samePeek,
} from "@/lib/peek/peek-state"

describe("parsePeek", () => {
  it("reads a post target", () => {
    expect(parsePeek("?post=abc")).toEqual({ kind: "post", id: "abc" })
  })

  it("reads a story target", () => {
    expect(parsePeek("?story=xyz")).toEqual({ kind: "story", id: "xyz" })
  })

  it("accepts a search string without the leading question mark", () => {
    expect(parsePeek("post=abc")).toEqual({ kind: "post", id: "abc" })
  })

  it("prefers post when both params are present", () => {
    expect(parsePeek("?story=xyz&post=abc")).toEqual({ kind: "post", id: "abc" })
  })

  it("treats an empty or whitespace value as no peek", () => {
    expect(parsePeek("?post=")).toBeNull()
    expect(parsePeek("?post=%20")).toBeNull()
    expect(parsePeek("?story=")).toBeNull()
    expect(parsePeek("")).toBeNull()
  })

  it("ignores unrelated params", () => {
    expect(parsePeek("?foo=bar")).toBeNull()
    expect(parsePeek("?foo=bar&post=abc")).toEqual({ kind: "post", id: "abc" })
  })

  it("accepts URLSearchParams directly", () => {
    expect(parsePeek(new URLSearchParams("?post=abc"))).toEqual({ kind: "post", id: "abc" })
  })
})

describe("peekSearch", () => {
  it("writes a post target and removes the other kind", () => {
    expect(peekSearch("?story=xyz", { kind: "post", id: "abc" })).toBe("?post=abc")
  })

  it("replaces an existing target of the same kind", () => {
    expect(peekSearch("?post=abc", { kind: "post", id: "def" })).toBe("?post=def")
  })

  it("clears both params for the list URL", () => {
    expect(peekSearch("?post=abc", null)).toBe("")
    expect(peekSearch("", null)).toBe("")
  })

  it("preserves unrelated params", () => {
    const out = peekSearch("?foo=bar&post=abc", { kind: "story", id: "xyz" })
    expect(out.startsWith("?")).toBe(true)
    const params = new URLSearchParams(out)
    expect(params.get("foo")).toBe("bar")
    expect(params.get("story")).toBe("xyz")
    expect(params.get("post")).toBeNull()
  })

  it("never leaves a bare question mark", () => {
    expect(peekSearch("?foo=bar", null)).toBe("?foo=bar")
    expect(peekSearch("?foo=", null)).toBe("?foo=")
  })

  it("round-trips through parsePeek", () => {
    const target = { kind: "story" as const, id: "s-1" }
    expect(parsePeek(peekSearch("", target))).toEqual(target)
  })
})

describe("samePeek", () => {
  it("is null-safe", () => {
    expect(samePeek(null, null)).toBe(true)
    expect(samePeek(null, { kind: "post", id: "a" })).toBe(false)
    expect(samePeek({ kind: "post", id: "a" }, null)).toBe(false)
  })

  it("compares kind and id", () => {
    expect(samePeek({ kind: "post", id: "a" }, { kind: "post", id: "a" })).toBe(true)
    expect(samePeek({ kind: "post", id: "a" }, { kind: "story", id: "a" })).toBe(false)
    expect(samePeek({ kind: "post", id: "a" }, { kind: "post", id: "b" })).toBe(false)
  })
})

describe("peekHref", () => {
  it("points at the canonical full-page route", () => {
    expect(peekHref({ kind: "post", id: "abc" })).toBe("/posts/abc")
    expect(peekHref({ kind: "story", id: "xyz" })).toBe("/stories/xyz")
  })
})
