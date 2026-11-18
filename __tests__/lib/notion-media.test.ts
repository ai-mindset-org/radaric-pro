/**
 * RAD-401 — Notion blocks for post / story media (lib/notion-media.ts).
 * Spec: AC-1 (one entry → one block), AC-2 (cover + rest), ERR-1 (url > 2000 skipped).
 * Pure module: inputs → outputs, no mocks.
 */
import { describe, it, expect } from "vitest"
import { notionMediaBlock, notionMediaSections } from "@/lib/notion-media"

const external = (type: string, url: string) => ({ type, [type]: { type: "external", external: { url } } })

describe("notionMediaBlock", () => {
  it("AC-1: image → image block, video file → video block, audio → audio block (external urls)", () => {
    expect(notionMediaBlock({ url: "https://cdn.example.com/a.jpg", kind: "image" })).toMatchObject(
      external("image", "https://cdn.example.com/a.jpg")
    )
    expect(notionMediaBlock({ url: "https://cdn.example.com/clip.mp4", kind: "video" })).toMatchObject(
      external("video", "https://cdn.example.com/clip.mp4")
    )
    expect(notionMediaBlock({ url: "https://cdn.example.com/voice.ogg", kind: "audio" })).toMatchObject(
      external("audio", "https://cdn.example.com/voice.ogg")
    )
  })

  it("AC-1: YouTube embeds (watch, youtu.be, /embed) → video block; any other embed → embed block", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ]) {
      expect(notionMediaBlock({ url, kind: "embed" })).toMatchObject(external("video", url))
    }
    const vimeo = "https://player.vimeo.com/video/123456"
    const block = notionMediaBlock({ url: vimeo, kind: "embed" })
    expect(block).toMatchObject({ type: "embed", embed: { url: vimeo } })
  })

  it("AC-1: document ending .pdf (before ?/#) → pdf block; other document → file block", () => {
    expect(notionMediaBlock({ url: "https://cdn.example.com/report.pdf", kind: "document" })).toMatchObject(
      external("pdf", "https://cdn.example.com/report.pdf")
    )
    expect(
      notionMediaBlock({ url: "https://cdn.example.com/report.pdf?sig=abc#page=2", kind: "document" })
    ).toMatchObject(external("pdf", "https://cdn.example.com/report.pdf?sig=abc#page=2"))
    expect(notionMediaBlock({ url: "https://cdn.example.com/kit.zip", kind: "document" })).toMatchObject(
      external("file", "https://cdn.example.com/kit.zip")
    )
  })

  it("AC-1: placeholder and unknown kinds → null", () => {
    expect(notionMediaBlock({ url: "tg://photo/42", kind: "placeholder" })).toBeNull()
    expect(notionMediaBlock({ url: "https://news.example.com/article", kind: "unknown" })).toBeNull()
    // Positive control in the same test: a real image is not null.
    expect(notionMediaBlock({ url: "https://cdn.example.com/a.jpg", kind: "image" })).toMatchObject({ type: "image" })
  })

  it("ERR-1: url longer than 2000 chars → null; exactly 2000 chars is still a block", () => {
    const base = "https://cdn.example.com/"
    const at2000 = base + "a".repeat(2000 - base.length - 4) + ".jpg"
    const at2001 = base + "a".repeat(2001 - base.length - 4) + ".jpg"
    expect(at2000.length).toBe(2000)
    expect(at2001.length).toBe(2001)
    expect(notionMediaBlock({ url: at2001, kind: "image" })).toBeNull()
    expect(notionMediaBlock({ url: at2000, kind: "image" })).toMatchObject(external("image", at2000))
  })
})

describe("notionMediaSections", () => {
  it("AC-2: cover = first image entry's block; rest = every other entry in order, nulls dropped", () => {
    const { cover, rest } = notionMediaSections([
      { url: "https://cdn.example.com/clip.mp4", kind: "video" },
      { url: "https://cdn.example.com/a.jpg", kind: "image" },
      { url: "tg://photo/7", kind: "placeholder" },
      { url: "https://cdn.example.com/b.png", kind: "image" },
      { url: "https://cdn.example.com/voice.mp3", kind: "audio" },
    ])
    expect(cover).toMatchObject(external("image", "https://cdn.example.com/a.jpg"))
    expect(rest).toHaveLength(3)
    expect(rest).toMatchObject([
      external("video", "https://cdn.example.com/clip.mp4"),
      external("image", "https://cdn.example.com/b.png"),
      external("audio", "https://cdn.example.com/voice.mp3"),
    ])
  })

  it("AC-2: no image entry → cover is null and every block goes to rest", () => {
    const { cover, rest } = notionMediaSections([
      { url: "https://cdn.example.com/clip.mp4", kind: "video" },
      { url: "https://cdn.example.com/kit.zip", kind: "document" },
    ])
    expect(cover).toBeNull()
    expect(rest).toMatchObject([
      external("video", "https://cdn.example.com/clip.mp4"),
      external("file", "https://cdn.example.com/kit.zip"),
    ])
  })

  it("ERR-1: an entry whose url is > 2000 chars is skipped, the others survive", () => {
    const long = "https://cdn.example.com/" + "b".repeat(2000) + ".jpg"
    const { cover, rest } = notionMediaSections([
      { url: "https://cdn.example.com/a.jpg", kind: "image" },
      { url: long, kind: "image" },
      { url: "https://cdn.example.com/c.jpg", kind: "image" },
    ])
    expect(cover).toMatchObject(external("image", "https://cdn.example.com/a.jpg"))
    expect(rest).toHaveLength(1)
    expect(rest).toMatchObject([external("image", "https://cdn.example.com/c.jpg")])
  })
})

// ---------------------------------------------------------------------------
// Code-review fixes (RAD-401 review round)
// ---------------------------------------------------------------------------

describe("notionMediaBlock — URL normalisation at the choke point", () => {
  it("rejects anything that is not an absolute http(s) URL → null", () => {
    for (const url of [
      "/img/og.png", // relative: Notion would 400 the whole page
      "//cdn.example.com/a.jpg", // protocol-relative
      "not a url at all",
      "",
      "data:image/png;base64,iVBORw0KGgo=",
      "tg://photo/42",
      "javascript:alert(1)",
      "ftp://cdn.example.com/a.jpg",
    ]) {
      expect(notionMediaBlock({ url, kind: "image" }), url).toBeNull()
    }
    // Positive control: a plain https image still maps.
    expect(notionMediaBlock({ url: "https://cdn.example.com/a.jpg", kind: "image" })).toMatchObject(
      external("image", "https://cdn.example.com/a.jpg")
    )
    expect(notionMediaBlock({ url: "http://cdn.example.com/a.jpg", kind: "image" })).toMatchObject(
      external("image", "http://cdn.example.com/a.jpg")
    )
  })

  it("surrounding whitespace is trimmed from the block URL", () => {
    expect(notionMediaBlock({ url: " https://cdn.example.com/a.jpg\n", kind: "image" })).toEqual(
      external("image", "https://cdn.example.com/a.jpg")
    )
  })

  it("the block carries the parsed href: spaces and non-ASCII are percent-encoded", () => {
    expect(notionMediaBlock({ url: "https://cdn.example.com/a b.jpg", kind: "image" })).toEqual(
      external("image", "https://cdn.example.com/a%20b.jpg")
    )
    expect(notionMediaBlock({ url: "https://cdn.example.com/фото.jpg", kind: "image" })).toEqual(
      external("image", "https://cdn.example.com/%D1%84%D0%BE%D1%82%D0%BE.jpg")
    )
  })

  it("the 2000-char limit is measured on the encoded href, not the raw string", () => {
    // 1990 raw chars, but every space becomes %20 — the href is well past 2000.
    const base = "https://cdn.example.com/"
    const raw = base + " ".repeat(1990 - base.length - 4) + ".jpg"
    expect(raw.length).toBe(1990)
    expect(notionMediaBlock({ url: raw, kind: "image" })).toBeNull()
  })
})

describe("notionMediaBlock — which YouTube URLs Notion's video block plays", () => {
  it("/watch?v=…, /embed/<id> and youtu.be/<id> → video block", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
    ]) {
      expect(notionMediaBlock({ url, kind: "embed" }), url).toMatchObject(external("video", url))
    }
  })

  it("any other YouTube URL (/shorts/, /live/, /embed/videoseries, /embed/live_stream, /watch without v) → embed block", () => {
    for (const url of [
      "https://www.youtube.com/shorts/abc123XYZ",
      "https://www.youtube.com/live/abc123XYZ",
      "https://www.youtube.com/embed/videoseries?list=PL123",
      "https://www.youtube.com/embed/live_stream?channel=UC123",
      "https://www.youtube.com/watch",
      "https://youtu.be/",
      "https://www.youtube.com/@channel",
    ]) {
      expect(notionMediaBlock({ url, kind: "embed" }), url).toEqual({ type: "embed", embed: { url } })
    }
  })
})

describe("notionMediaSections — cover fallback", () => {
  it("an oversized FIRST image does not take the cover with it: the next image becomes the cover", () => {
    const long = "https://cdn.example.com/" + "b".repeat(2000) + ".jpg"
    const { cover, rest } = notionMediaSections([
      { url: long, kind: "image" },
      { url: "https://cdn.example.com/second.jpg", kind: "image" },
      { url: "https://cdn.example.com/third.jpg", kind: "image" },
    ])
    expect(cover).toEqual(external("image", "https://cdn.example.com/second.jpg"))
    expect(rest).toEqual([external("image", "https://cdn.example.com/third.jpg")])
  })
})
