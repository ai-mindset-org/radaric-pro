/**
 * Telegram rich-text renderer — conversion contract (node, static markup).
 *
 * Structure only: the interactive leaves and the text-integrity invariant live
 * in __tests__/components/telegram-rich-text.test.tsx (jsdom).
 */

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  convertTelegramEntitiesToReact,
  adjustEntitiesForExcerpt,
  shiftContentEntities,
  type TelegramEntity,
  type RichTextVariant,
} from "@/lib/telegram-entities-to-react"

function html(text: string, entities: TelegramEntity[], variant?: RichTextVariant): string {
  return renderToStaticMarkup(<>{convertTelegramEntitiesToReact(text, entities, variant)}</>)
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1

describe("convertTelegramEntitiesToReact — entity coverage", () => {
  it("renders plain text when there are no entities", () => {
    const markup = html("hello world", [])
    expect(markup).toContain("hello world")
    expect(markup).not.toMatch(/<(a|strong|em|blockquote|pre|button)[\s>]/)
  })

  it("renders nothing for empty text", () => {
    expect(html("", [])).toBe("")
  })

  it.each([
    ["MessageEntityBold", "strong"],
    ["MessageEntityItalic", "em"],
    ["MessageEntityUnderline", "u"],
    ["MessageEntityStrike", "s"],
  ])("wraps %s", (className, tag) => {
    const markup = html("word", [{ className, offset: 0, length: 4 }])
    expect(markup).toContain(`<${tag}>word</${tag}>`)
  })

  it("renders inline code with the mono chip classes", () => {
    const markup = html("npm i", [{ className: "MessageEntityCode", offset: 0, length: 5 }])
    expect(markup).toContain("<code")
    expect(markup).toContain("font-mono")
    expect(markup).toContain("npm i")
  })

  it("renders a pre block as <pre><code>", () => {
    const markup = html("const x = 1", [{ className: "MessageEntityPre", offset: 0, length: 11 }])
    expect(markup).toContain("<pre")
    expect(markup).toMatch(/<pre[^>]*>.*<code[^>]*>.*const x = 1.*<\/code>.*<\/pre>/)
  })

  it("nests a pre inside its blockquote instead of opening a second quote", () => {
    const text = "intro\ncode here\noutro"
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBlockquote", offset: 0, length: text.length },
      { className: "MessageEntityPre", offset: 6, length: 9 },
    ]
    const markup = html(text, entities)
    expect(count(markup, "<blockquote")).toBe(1)
    expect(count(markup, "<pre")).toBe(1)
    expect(markup.indexOf("<pre")).toBeGreaterThan(markup.indexOf("<blockquote"))
  })

  it("keeps a blockquote as one block when inline entities nest inside it", () => {
    const text = "quote line with bold inside"
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBlockquote", offset: 0, length: text.length },
      { className: "MessageEntityBold", offset: 16, length: 4 },
    ]
    const markup = html(text, entities)
    expect(count(markup, "<blockquote")).toBe(1)
    expect(markup).toContain("<strong>bold</strong>")
  })

  it("keeps two quotes separated by non-whitespace text as two blocks", () => {
    const text = "first quote between second quote"
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBlockquote", offset: 0, length: 11 },
      { className: "MessageEntityBlockquote", offset: 20, length: 12 },
    ]
    const markup = html(text, entities)
    expect(count(markup, "<blockquote")).toBe(2)
    expect(markup).toContain("<blockquote")
    expect(markup).toContain("first quote")
    expect(markup).toContain("second quote")
  })

  it("merges per-paragraph quote entities separated only by whitespace, keeping the break", () => {
    const text = "quote one\n\nquote two"
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBlockquote", offset: 0, length: 9 },
      { className: "MessageEntityBlockquote", offset: 11, length: 9 },
    ]
    const markup = html(text, entities)
    expect(count(markup, "<blockquote")).toBe(1)
    expect(markup).toContain("quote one\n\nquote two")
  })

  it("merges per-paragraph collapsed quotes into one toggle", () => {
    const text = "quote one\n\nquote two"
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBlockquote", offset: 0, length: 9, collapsed: true },
      { className: "MessageEntityBlockquote", offset: 11, length: 9, collapsed: true },
    ]
    const markup = html(text, entities)
    expect(count(markup, "Show more")).toBe(1)
    expect(markup).toContain("quote one\n\nquote two")
  })

  it("renders the tail of a partially overlapping entity instead of dropping it", () => {
    const markup = html("abcdefgh", [
      { className: "MessageEntityBold", offset: 0, length: 5 },
      { className: "MessageEntityItalic", offset: 3, length: 5 },
    ])
    expect(markup).toContain("<strong>abcde</strong>")
    expect(markup).toContain("<em>fgh</em>")
  })

  it("downgrades a block to its inline form inside an inline wrapper", () => {
    const text = "abc code def"
    const markup = html(text, [
      { className: "MessageEntityBold", offset: 0, length: 12 },
      { className: "MessageEntityPre", offset: 4, length: 4 },
    ])
    expect(markup).not.toContain("<pre")
    expect(markup).toContain("<strong>")
    expect(markup).toContain("font-mono")
  })

  it("renders a collapsed blockquote with a toggle in the full variant", () => {
    const markup = html("long quote", [
      { className: "MessageEntityBlockquote", offset: 0, length: 10, collapsed: true },
    ])
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain("Show more")
  })

  it("does not turn a collapsed flag into a toggle in the compact variant", () => {
    const markup = html("long quote", [
      { className: "MessageEntityBlockquote", offset: 0, length: 10, collapsed: true },
    ], "compact")
    expect(markup).not.toContain("Show more")
    expect(markup).not.toContain("<button")
  })
})

describe("convertTelegramEntitiesToReact — links and protocols", () => {
  it("renders a TextUrl anchor with target and rel", () => {
    const markup = html("click", [
      { className: "MessageEntityTextUrl", offset: 0, length: 5, url: "https://example.com" },
    ])
    expect(markup).toContain('href="https://example.com"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
  })

  it("renders a plain Url entity as an anchor to its own text", () => {
    const markup = html("https://example.com", [
      { className: "MessageEntityUrl", offset: 0, length: 19 },
    ])
    expect(markup).toContain('href="https://example.com"')
  })

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "tg://resolve?domain=x",
  ])("refuses to anchor %s", (url) => {
    const markup = html("link", [
      { className: "MessageEntityTextUrl", offset: 0, length: 4, url },
    ])
    expect(markup).not.toContain("<a")
    expect(markup).toContain("link")
  })

  it("renders @mentions as t.me links", () => {
    const markup = html("@durov", [{ className: "MessageEntityMention", offset: 0, length: 6 }])
    expect(markup).toContain('href="https://t.me/durov"')
  })

  it("renders email and phone entities with their protocols", () => {
    const email = html("a@b.co", [{ className: "MessageEntityEmail", offset: 0, length: 6 }])
    expect(email).toContain('href="mailto:a@b.co"')

    const phone = html("+7 999 123-45-67", [
      { className: "MessageEntityPhone", offset: 0, length: 16 },
    ])
    expect(phone).toContain('href="tel:+79991234567"')
  })

  it("nests a link inside bold", () => {
    const markup = html("bold link", [
      { className: "MessageEntityBold", offset: 0, length: 9 },
      { className: "MessageEntityTextUrl", offset: 5, length: 4, url: "https://x.com" },
    ])
    expect(markup).toMatch(
      /<strong>bold <a [^>]*href="https:\/\/x\.com"[^>]*>link<\/a><\/strong>/
    )
  })

  it("passes unknown entity classes through as plain text", () => {
    const markup = html("text", [
      { className: "MessageEntitySomeFutureThing", offset: 0, length: 4 },
    ])
    expect(markup).toContain("text")
    expect(markup).not.toMatch(/<strong|<em|<a[\s>]/)
  })
})

describe("convertTelegramEntitiesToReact — offsets and variants", () => {
  it("clamps entities to the text and drops degenerate ones", () => {
    const beyond = html("short", [{ className: "MessageEntityBold", offset: 100, length: 5 }])
    expect(beyond).not.toContain("<strong")

    const zero = html("short", [{ className: "MessageEntityBold", offset: 2, length: 0 }])
    expect(zero).not.toContain("<strong")

    const overhang = html("short", [{ className: "MessageEntityBold", offset: 3, length: 50 }])
    expect(overhang).toContain("<strong>rt</strong>")
  })

  it("honours UTF-16 offsets when an astral emoji precedes the entity", () => {
    const markup = html("😈 bold", [{ className: "MessageEntityBold", offset: 3, length: 4 }])
    expect(markup).toContain("<strong>bold</strong>")
    expect(markup).toContain("😈")
  })

  it("emits no block or interactive elements in the compact variant", () => {
    const text = "quote\ncode"
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBlockquote", offset: 0, length: 5, collapsed: true },
      { className: "MessageEntityPre", offset: 6, length: 4 },
      { className: "MessageEntitySpoiler", offset: 0, length: 5 },
    ]
    const markup = html(text, entities, "compact")
    expect(markup).not.toContain("<blockquote")
    expect(markup).not.toContain("<pre")
    expect(markup).not.toContain("<button")
    expect(markup).toContain("italic")
    expect(markup).toContain("aria-hidden")
    expect(markup).toContain("text-transparent")
  })

  it("renders links inside a spoiler as plain text in both variants", () => {
    const text = "click https://x.com"
    const entities: TelegramEntity[] = [
      { className: "MessageEntitySpoiler", offset: 0, length: 19 },
      { className: "MessageEntityUrl", offset: 6, length: 13 },
    ]
    expect(html(text, entities)).not.toContain("<a")
    expect(html(text, entities, "compact")).not.toContain("<a")
  })
})

describe("excerpt helpers", () => {
  it("adjustEntitiesForExcerpt keeps inside, clips straddling, drops outside", () => {
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBold", offset: 0, length: 4 },
      { className: "MessageEntityBold", offset: 8, length: 6 },
      { className: "MessageEntityBold", offset: 14, length: 2 },
    ]
    expect(adjustEntitiesForExcerpt(entities, 10)).toEqual([
      { className: "MessageEntityBold", offset: 0, length: 4 },
      { className: "MessageEntityBold", offset: 8, length: 2 },
    ])
  })

  it("shiftContentEntities re-bases and drops entities before the cut", () => {
    const entities: TelegramEntity[] = [
      { className: "MessageEntityBold", offset: 0, length: 3 },
      { className: "MessageEntityBold", offset: 5, length: 4 },
    ]
    expect(shiftContentEntities(entities, 4)).toEqual([
      { className: "MessageEntityBold", offset: 1, length: 4 },
    ])
    expect(shiftContentEntities(entities, 0)).toBe(entities)
  })
})
