/**
 * RAD-345 — peek history plan.
 *
 * The sequences that decide whether Back closes the peek or leaves the page:
 * first open pushes, swaps replace, close is back() for an entry we pushed and
 * replaceState for a deep link. Real browser history semantics are verified in
 * the real-browser pass; these pin the decision logic.
 */
import { describe, expect, it } from "vitest"
import { peekNeighbour, planPeekClose, planPeekOpen } from "@/lib/peek/peek-nav"

const base = { pathname: "/posts", search: "" }

describe("planPeekOpen", () => {
  it("pushes on the first open", () => {
    expect(
      planPeekOpen({ ...base, current: null, next: { kind: "post", id: "a" } })
    ).toEqual({ type: "push", url: "/posts?post=a" })
  })

  it("replaces when swapping targets — one peek, one entry", () => {
    expect(
      planPeekOpen({
        ...base,
        current: { kind: "post", id: "a" },
        next: { kind: "post", id: "b" },
      })
    ).toEqual({ type: "replace", url: "/posts?post=b" })
  })

  it("replaces when the kind changes", () => {
    expect(
      planPeekOpen({
        ...base,
        current: { kind: "story", id: "s" },
        next: { kind: "post", id: "a" },
      })
    ).toEqual({ type: "replace", url: "/posts?post=a" })
  })

  it("does nothing when the target is already open", () => {
    expect(
      planPeekOpen({
        ...base,
        current: { kind: "post", id: "a" },
        next: { kind: "post", id: "a" },
      })
    ).toEqual({ type: "none" })
  })

  it("keeps the existing search string", () => {
    expect(
      planPeekOpen({
        pathname: "/feeds/f1",
        search: "?foo=bar",
        current: null,
        next: { kind: "story", id: "s" },
      })
    ).toEqual({ type: "push", url: "/feeds/f1?foo=bar&story=s" })
  })
})

describe("planPeekClose", () => {
  it("rewrites the entry to the clean list URL — never history.back()", () => {
    expect(planPeekClose({ ...base, search: "?post=a" })).toEqual({
      type: "replace",
      url: "/posts",
    })
  })

  it("preserves unrelated params when stripping", () => {
    expect(planPeekClose({ pathname: "/posts", search: "?foo=bar&post=a" })).toEqual({
      type: "replace",
      url: "/posts?foo=bar",
    })
  })
})

describe("peekNeighbour", () => {
  const order = [
    { kind: "post" as const, id: "a" },
    { kind: "story" as const, id: "s" },
    { kind: "post" as const, id: "b" },
  ]

  it("steps to the neighbour on either side", () => {
    expect(peekNeighbour(order, order[0], "next")).toEqual({ kind: "story", id: "s" })
    expect(peekNeighbour(order, order[2], "previous")).toEqual({ kind: "story", id: "s" })
  })

  it("is null at the ends", () => {
    expect(peekNeighbour(order, order[2], "next")).toBeNull()
    expect(peekNeighbour(order, order[0], "previous")).toBeNull()
  })

  it("is null for a target the order does not hold", () => {
    expect(peekNeighbour(order, { kind: "post", id: "other" }, "next")).toBeNull()
  })
})
