/**
 * Pure function tests for the shared post-title derivation policy (lib/title.ts).
 * Tweets, Telegram posts, and titleless RSS items have no headline of their
 * own — derivePostTitle pulls a short lede from the first line/sentence of
 * the post; isDerivedTitle recognizes when a stored title IS that lede (so
 * render surfaces can skip repeating it in the excerpt/body).
 * Spec: RAD-315 (lede titles for post-shaped sources).
 */

import { describe, it, expect } from "vitest"
import {
  derivePostTitle,
  isDerivedTitle,
  splitDerivedBody,
  splitDerivedBodyHtml,
  isPlaceholderTitle,
  derivedTitleHtml,
  remapToDerivedTitle,
  HEADLINE_MAX_LENGTH,
} from "@/lib/title"

describe("derivePostTitle", () => {
  it("AC-1: takes the first sentence of the first line, not the whole text", () => {
    const text = "Goodbye per-seat pricing.\n\nPer-user pricing has always rubbed me the wrong way."
    expect(derivePostTitle(text)).toBe("Goodbye per-seat pricing.")
  })

  it("AC-2: strips t.co links from the derived headline", () => {
    expect(derivePostTitle("Here we go https://t.co/V8cDsgD4Ii")).toBe("Here we go")
  })

  it("AC-3: truncates a first sentence longer than 120 characters at a word boundary with an ellipsis", () => {
    const words = Array.from({ length: 30 }, (_, i) => `wordnumber${i}`)
    const text = words.join(" ") // no punctuation — the whole text is one "sentence"
    const result = derivePostTitle(text)

    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(121)
    expect(result!.endsWith("…")).toBe(true)

    const body = result!.slice(0, -1).trimEnd()
    expect(text.startsWith(body)).toBe(true)
    const nextChar = text[body.length]
    expect(nextChar === " " || nextChar === undefined).toBe(true)
  })

  it("AC-4: returns null when nothing usable remains after stripping links", () => {
    expect(derivePostTitle("https://t.co/smgJJlwKZQ")).toBeNull()
  })

  it("AC-7: isDerivedTitle recognizes a derived title as a prefix of content, tolerating a trailing ellipsis", () => {
    expect(
      isDerivedTitle("Goodbye per-seat pricing.", "Goodbye per-seat pricing.\n\nMore text after it.")
    ).toBe(true)
    expect(
      isDerivedTitle("Goodbye per-seat…", "Goodbye per-seat pricing continues here beyond the cut.")
    ).toBe(true)
    expect(
      isDerivedTitle(
        "A real headline unrelated to the opening line",
        "This article discusses various strategies for SaaS pricing in depth."
      )
    ).toBe(false)
  })

  it("EC-1: drops the 'RT @user: ' prefix", () => {
    expect(derivePostTitle("RT @naval: Everyone will soon have “AI Anxiety.”")).toBe(
      "Everyone will soon have “AI Anxiety.”"
    )
  })

  it("EC-2: returns null for empty or whitespace-only text", () => {
    expect(derivePostTitle("")).toBeNull()
    expect(derivePostTitle("   \n  ")).toBeNull()
  })

  it("EC-3: isDerivedTitle recognizes a legacy title capped at 300 characters with a trailing ellipsis", () => {
    const content = "x".repeat(400)
    const legacyTitle = content.slice(0, 300) + "…"
    expect(isDerivedTitle(legacyTitle, content)).toBe(true)
  })
})

describe("derivePostTitle — review round 2", () => {
  it("falls through to the next line when the first one is a bare link", () => {
    expect(derivePostTitle("https://example.com/a\n\nРазбор новой модели и что она меняет")).toBe(
      "Разбор новой модели и что она меняет"
    )
  })

  it("keeps the sentence going past an abbreviation period", () => {
    expect(derivePostTitle("According to the U.S. Census Bureau the trend reversed. Details below.")).toBe(
      "According to the U.S. Census Bureau the trend reversed."
    )
  })

  it("never cuts a headline in the middle of an emoji surrogate pair", () => {
    // Fill exactly to the cap so the cut would land inside the emoji.
    const text = "a".repeat(HEADLINE_MAX_LENGTH) + "🚀 and more words after the cap"
    const result = derivePostTitle(text)!
    expect(result.endsWith("…")).toBe(true)
    const beforeEllipsis = result.slice(0, -1)
    const lastCode = beforeEllipsis.charCodeAt(beforeEllipsis.length - 1)
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false)
  })
})

describe("isDerivedTitle — review round 2", () => {
  it("does not treat a short real title as derived just because content starts with the same characters", () => {
    expect(isDerivedTitle("Rust", "Rust-based tooling is eating the JavaScript ecosystem.")).toBe(false)
    expect(isDerivedTitle("OpenAI", "OpenAI's new model ships today.")).toBe(false)
    expect(isDerivedTitle("The state of AI", "The state of AI-native tooling in 2026.")).toBe(false)
  })

  it("still tolerates a mid-token cut when the title was actually truncated", () => {
    expect(isDerivedTitle("Rust…", "Rust-based tooling is eating the JavaScript ecosystem.")).toBe(true)
  })

  it("does not skip an 'RT' that is an ordinary word mid-sentence", () => {
    expect(isDerivedTitle("The team shipped", "The RT team shipped a new build")).toBe(false)
  })

  it("matches a title derived from a line below a leading bare link", () => {
    const content = "https://example.com/a\n\nРазбор новой модели"
    expect(isDerivedTitle("Разбор новой модели", content)).toBe(true)
    expect(splitDerivedBody("Разбор новой модели", content)).toBe("")
  })

  it("trims a dangling ellipsis left at the head of the remainder", () => {
    // The title was cut mid-token, so the remainder opens on the tail of that
    // token's punctuation — it must not start with a stray ellipsis.
    expect(
      splitDerivedBody("Goodbye per-seat pricing…", "Goodbye per-seat pricing… and the rest follows")
    ).toBe("and the rest follows")
  })
})

describe("splitDerivedBodyHtml", () => {
  it("cuts the derived opening out of an HTML body and keeps the markup after it", () => {
    expect(
      splitDerivedBodyHtml(
        "Goodbye per-seat pricing.",
        "<p>Goodbye per-seat pricing.</p>\n<p>Per-user pricing has always rubbed me the wrong way.</p>"
      )
    ).toBe("<p>Per-user pricing has always rubbed me the wrong way.</p>")
  })

  it("keeps the paragraph open when the lede and the rest share one block", () => {
    expect(
      splitDerivedBodyHtml(
        "Goodbye per-seat pricing.",
        "<p>Goodbye per-seat pricing. Per-user pricing has always rubbed me the wrong way.</p>"
      )
    ).toBe("<p>Per-user pricing has always rubbed me the wrong way.</p>")
  })

  it("re-opens every block the title leaves open", () => {
    expect(
      splitDerivedBodyHtml(
        "Goodbye per-seat pricing.",
        "<blockquote><p>Goodbye per-seat pricing. Rest of it.</p></blockquote><p>Next.</p>"
      )
    ).toBe("<blockquote><p>Rest of it.</p></blockquote><p>Next.</p>")
  })

  it("leaves the body untouched when tags split the title's own words — the card agrees and doesn't cut either", () => {
    const html = "<p><strong>Goodbye</strong> per-seat pricing.</p><p>More.</p>"
    expect(splitDerivedBodyHtml("Goodbye per-seat pricing.", html)).toBe(html)
    // `stripHtml` runs tag boundaries together, so the same words the card
    // sees ("…pricing.More.") are not a derived headline there either.
    expect(splitDerivedBody("Goodbye per-seat pricing.", "Goodbye per-seat pricing.More.")).toBe(
      "Goodbye per-seat pricing.More."
    )
  })

  it("matches a title whose words a line break separates in the markup", () => {
    expect(
      splitDerivedBodyHtml(
        "Goodbye per-seat pricing.",
        "<p>Goodbye per-seat\npricing. Per-user pricing has always rubbed me the wrong way.</p>"
      )
    ).toBe("<p>Per-user pricing has always rubbed me the wrong way.</p>")
  })

  it("returns an empty body when the derived title is all the post has", () => {
    expect(splitDerivedBodyHtml("Goodbye per-seat pricing.", "<p>Goodbye per-seat pricing.</p>")).toBe("")
  })

  it("leaves the body untouched when the title is not derived from it", () => {
    const html = "<p>Intro text.</p><p>Goodbye per-seat pricing. More.</p>"
    expect(splitDerivedBodyHtml("A hand-written headline", html)).toBe(html)
  })

  it("does not cut a title that only appears later in the document", () => {
    const html = "<p>Intro text.</p><p>Goodbye per-seat pricing. More.</p>"
    expect(splitDerivedBodyHtml("Goodbye per-seat pricing.", html)).toBe(html)
  })

  it("treats a whitespace entity as a separator on both surfaces", () => {
    const html = "<p>Good&nbsp;title. Rest.</p>"
    expect(splitDerivedBody("Good title.", "Good title. Rest.")).toBe("Rest.")
    expect(splitDerivedBodyHtml("Good title.", html)).toBe("<p>Rest.</p>")
  })

  it("leaves the body untouched when a non-whitespace entity keeps the raw markup from matching", () => {
    const html = "<p>AT&amp;T is a giant. Rest.</p>"
    // The gate runs on `stripHtml` (which keeps the escaped form), so the card
    // agrees: neither surface treats this as a derived headline.
    expect(splitDerivedBodyHtml("AT&T is a giant.", html)).toBe(html)
    expect(splitDerivedBody("AT&T is a giant.", "AT&amp;T is a giant. Rest.")).toBe(
      "AT&amp;T is a giant. Rest."
    )
  })

  it("leaves the body untouched when the markup before the title is unbalanced", () => {
    const html = "<p></div>Goodbye per-seat pricing. Rest."
    expect(splitDerivedBodyHtml("Goodbye per-seat pricing.", html)).toBe(html)
  })

  it("trims a dangling ellipsis from the HTML remainder like splitDerivedBody does", () => {
    expect(
      splitDerivedBodyHtml("Goodbye per-seat…", "<p>Goodbye per-seat… and the rest follows</p>")
    ).toBe("<p>and the rest follows</p>")
  })

  it("cuts mid-token exactly like splitDerivedBody when the title was truncated", () => {
    expect(
      splitDerivedBodyHtml("Goodbye per-seat…", "<p>Goodbye per-seat pricing continues here.</p>")
    ).toBe("<p>pricing continues here.</p>")
  })
})

describe("remapToDerivedTitle", () => {
  it("moves an entity from the content onto the derived headline's own offsets", () => {
    // The stored title drops "RT @naval: ", so every headline word sits at a
    // different offset than in the content — the map has to close that gap.
    const content = "RT @naval: Everyone will soon have AI anxiety. More follows."
    const title = derivePostTitle(content)!
    const start = content.indexOf("AI anxiety")
    const titleStart = title.indexOf("AI anxiety")

    expect(start).toBeGreaterThan(titleStart)
    expect(
      remapToDerivedTitle(title, content, [
        { className: "MessageEntityBold", offset: start, length: "AI anxiety".length },
      ])
    ).toEqual([
      { className: "MessageEntityBold", offset: titleStart, length: "AI anxiety".length },
    ])
  })

  it("keeps an entity that spans several headline words as one contiguous run", () => {
    const content = "RT @naval: Everyone will soon have AI anxiety. More follows."
    const title = derivePostTitle(content)!
    const phrase = "have AI anxiety"

    expect(
      remapToDerivedTitle(title, content, [
        { className: "MessageEntityTextUrl", offset: content.indexOf(phrase), length: phrase.length },
      ])
    ).toEqual([
      {
        className: "MessageEntityTextUrl",
        offset: title.indexOf(phrase),
        length: phrase.length,
      },
    ])
  })

  it("maps around a skipped line rather than only a skipped prefix", () => {
    const content = "https://example.com/a\n\nРазбор новой модели"
    const title = "Разбор новой модели"
    const phrase = "новой модели"

    expect(
      remapToDerivedTitle(title, content, [
        { className: "MessageEntityUnderline", offset: content.indexOf(phrase), length: phrase.length },
      ])
    ).toEqual([
      { className: "MessageEntityUnderline", offset: title.indexOf(phrase), length: phrase.length },
    ])
  })

  it("drops an entity that only lives in the body the headline left behind", () => {
    const content = "Goodbye per-seat pricing. More follows here."
    const title = "Goodbye per-seat pricing."

    expect(
      remapToDerivedTitle(title, content, [
        { className: "MessageEntityBold", offset: content.indexOf("More"), length: 4 },
      ])
    ).toEqual([])
  })

  it("drops an entity on a bare link the headline cleaning removed", () => {
    const content = "Check this https://t.co/abc out. More follows."
    const title = derivePostTitle(content)!
    const url = "https://t.co/abc"

    expect(title).toBe("Check this out.")
    expect(
      remapToDerivedTitle(title, content, [
        { className: "MessageEntityUrl", offset: content.indexOf(url), length: url.length },
      ])
    ).toEqual([])
  })

  it("clips an entity that runs past the truncation cut of a capped headline", () => {
    const content = Array.from({ length: 20 }, (_, i) => `word${String(i).padStart(2, "0")}xxxxx`).join(" ")
    const title = derivePostTitle(content)!
    const cut = title.length - 1 // the headline's own characters, without the "…"
    const entityStart = cut - 4

    expect(title.endsWith("…")).toBe(true)
    expect(
      remapToDerivedTitle(title, content, [{ className: "MessageEntityBold", offset: entityStart, length: 40 }])
    ).toEqual([{ className: "MessageEntityBold", offset: entityStart, length: 4 }])
  })

  it("returns nothing for a hand-written headline", () => {
    expect(
      remapToDerivedTitle("A real headline of its own", "This article discusses pricing at length.", [
        { className: "MessageEntityBold", offset: 0, length: 4 },
      ])
    ).toEqual([])
  })

  it("maps onto the stored title's own characters, not a normalised copy", () => {
    // The renderer prints `title` as stored; a run of extra whitespace must
    // shift the entity with it rather than landing a character early.
    expect(
      remapToDerivedTitle("Good  title.", "Good title. Rest.", [
        { className: "MessageEntityBold", offset: 5, length: 6 },
      ])
    ).toEqual([{ className: "MessageEntityBold", offset: 6, length: 6 }])
  })
})

describe("derivedTitleHtml", () => {
  it("keeps a link that wraps the headline's words", () => {
    const html =
      '<p><a href="https://example.com/post">Goodbye per-seat pricing.</a> Per-user pricing follows.</p>'

    expect(derivedTitleHtml("Goodbye per-seat pricing.", html)).toBe(
      '<a href="https://example.com/post">Goodbye per-seat pricing.</a>'
    )
  })

  it("unwraps emphasis markup to plain text and leaves the block wrapper behind", () => {
    const html = "<p><strong>Goodbye</strong> <em>per-seat</em> pricing. Per-user pricing follows.</p>"

    expect(derivedTitleHtml("Goodbye per-seat pricing.", html)).toBe("Goodbye per-seat pricing.")
  })

  it("unwraps a br but refuses one that joins two of the title's words", () => {
    // A flanking space survives the unwrap; a br the strip drops without a
    // space would make the cut disagree with the stored title, so it falls
    // back to the plain one rather than joining the words.
    expect(
      derivedTitleHtml("Goodbye per-seat pricing.", "<p>Goodbye <br>per-seat pricing. More.</p>")
    ).toBe("Goodbye per-seat pricing.")
    expect(
      derivedTitleHtml("Goodbye per-seat pricing.", "<p>Goodbye<br>per-seat pricing. More.</p>")
    ).toBeNull()
  })

  it("keeps a link but drops the emphasis inside and around it", () => {
    const html =
      '<p><strong><a href="https://example.com/post">Goodbye <em>per-seat</em> pricing.</a></strong> Per-user follows.</p>'

    expect(derivedTitleHtml("Goodbye per-seat pricing.", html)).toBe(
      '<a href="https://example.com/post">Goodbye per-seat pricing.</a>'
    )
  })

  it("cuts a truncated headline mid-token and keeps the ellipsis", () => {
    expect(derivedTitleHtml("Goodbye per-seat…", "<p>Goodbye per-seat pricing continues.</p>")).toBe(
      "Goodbye per-seat…"
    )
  })

  it("keeps the title's own suffix instead of normalising it to an ellipsis", () => {
    expect(derivedTitleHtml("Wait for it...", "<p>Wait for it... More follows here.</p>")).toBe(
      "Wait for it..."
    )
  })

  it("normalises a decoded non-breaking space so the headline reads as the title", () => {
    // sanitize-html decodes `&nbsp;` at ingest, so the stored content holds a
    // literal U+00A0 while the title has a plain space.
    expect(derivedTitleHtml("Good title.", "<p>Good\u00a0title. Rest.</p>")).toBe("Good title.")
  })

  it("returns null when an inline tag splits one of the title's words", () => {
    // `htmlTokens` reads this as "Rust" + "-based", so no rich headline is
    // taken and the stored title renders as plain text — the graceful floor
    // for markup the word matcher can't map (splitDerivedBodyHtml shares it).
    expect(
      derivedTitleHtml("Rust-based tooling is eating.", "<p><strong>Rust</strong>-based tooling is eating. Rest.</p>")
    ).toBeNull()
  })

  it("returns null when the markup's text doesn't read as the headline", () => {
    // The bare URL stays in the raw markup (tags are invisible to the match)
    // but the derived headline dropped it — a rich headline would disagree
    // with the stored title, so the caller keeps the plain text.
    const html = '<p>Check this <a href="https://t.co/abc">https://t.co/abc</a> out. More.</p>'
    expect(derivedTitleHtml("Check this out.", html)).toBeNull()
  })

  it("returns null for a hand-written headline", () => {
    expect(derivedTitleHtml("A real headline of its own", "<p>Intro text. More.</p>")).toBeNull()
  })

  it("returns null when a non-whitespace entity keeps the raw markup from matching", () => {
    expect(derivedTitleHtml("AT&T is a giant.", "<p>AT&amp;T is a giant. Rest.</p>")).toBeNull()
  })
})

describe("isPlaceholderTitle", () => {
  it("recognizes shape-only fallback titles", () => {
    expect(isPlaceholderTitle("Photo from @naval")).toBe(true)
    expect(isPlaceholderTitle("Post from @durov")).toBe(true)
    expect(isPlaceholderTitle("Untitled")).toBe(true)
  })

  it("leaves a real headline alone", () => {
    expect(isPlaceholderTitle("Goodbye per-seat pricing.")).toBe(false)
    expect(isPlaceholderTitle("A photo from the Mars rover changed everything")).toBe(false)
  })
})
