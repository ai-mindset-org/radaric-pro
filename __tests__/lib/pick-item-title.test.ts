/**
 * Pure function tests for pickItemTitle (lib/parsers/rss.ts).
 * Bluesky profile RSS items carry no <title> — the post text lives in the
 * description — so the parser derives a title from the snippet. RAD-268
 */

import { describe, it, expect } from "vitest"
import { pickItemTitle } from "@/lib/parsers/rss"
import { HEADLINE_MAX_LENGTH } from "@/lib/title"

describe("pickItemTitle", () => {
  it("uses the item title when present", () => {
    expect(pickItemTitle({ title: "A real title", contentSnippet: "body" })).toBe("A real title")
  })

  it("derives the title from contentSnippet when title is missing", () => {
    expect(pickItemTitle({ contentSnippet: "Just shipped a new feature for our app" })).toBe(
      "Just shipped a new feature for our app"
    )
  })

  it("treats an empty title as missing", () => {
    expect(pickItemTitle({ title: "", contentSnippet: "fallback text" })).toBe("fallback text")
  })

  it("caps a derived title at the headline length with an ellipsis", () => {
    const long = "x".repeat(400)
    const result = pickItemTitle({ contentSnippet: long })
    // A derived title is a lede headline (HEADLINE_MAX_LENGTH), not a 300-char
    // copy of the post — the post body still renders in full below it.
    expect(result).toHaveLength(HEADLINE_MAX_LENGTH + 1)
    expect(result.endsWith("…")).toBe(true)
  })

  it("caps a long real title at 300 characters too", () => {
    const long = "y".repeat(400)
    const result = pickItemTitle({ title: long })
    expect(result).toHaveLength(301)
    expect(result.endsWith("…")).toBe(true)
  })

  it("returns a short real title in full", () => {
    const short = "y".repeat(120)
    expect(pickItemTitle({ title: short })).toBe(short)
  })

  it("takes only the first line of a multi-line snippet as the derived title", () => {
    expect(pickItemTitle({ contentSnippet: "line one\n\nline two" })).toBe("line one")
  })

  it("collapses runs of whitespace inside a derived title", () => {
    expect(pickItemTitle({ contentSnippet: "line   one" })).toBe("line one")
  })

  it("returns Untitled when neither title nor snippet exists", () => {
    expect(pickItemTitle({})).toBe("Untitled")
    expect(pickItemTitle({ contentSnippet: "   " })).toBe("Untitled")
  })
})
