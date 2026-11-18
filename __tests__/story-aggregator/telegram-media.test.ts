/**
 * `lib/story-aggregator/telegram-media` — pure, duck-typed Telegram media
 * parsing for the feed parser (RAD-359).
 *
 * The module imports no GramJS: these calls pin the grouping, placeholder,
 * boundary and item-building rules against plain message shapes, matching the
 * module's own duck-typed contract.
 */

import { describe, it, expect } from "vitest"
import {
  splitMessages,
  mediaPlaceholder,
  messageContent,
  buildSingleItem,
  buildAlbumItem,
  needsBoundaryFetch,
  boundaryAlbumMembers,
  mirrorUnits,
  createMediaBudget,
  cleanChannelUsername,
} from "@/lib/story-aggregator/telegram-media"

// ---------------------------------------------------------------------------
// Fixtures — plain duck-typed shapes (no GramJS)
// ---------------------------------------------------------------------------

interface DuckMessage {
  id: number
  message: string
  entities?: Array<{ className: string; offset: number; length: number }>
  media: unknown
  groupedId: string | null
  date: number
}

interface MediaResultLike {
  url: string | null
  type: string | null
  thumbUrl: string | null
  skipped: boolean
}

function makeMessage(overrides: Partial<DuckMessage> = {}): DuckMessage {
  return {
    id: 1,
    message: "",
    media: null,
    groupedId: null,
    date: 1_700_000_000,
    ...overrides,
  }
}

const photoMedia = () => ({ className: "MessageMediaPhoto" })
const webpagePhotoMedia = () => ({ className: "MessageMediaWebPage", webpage: { photo: {} } })
const webpageLinkMedia = () => ({ className: "MessageMediaWebPage", webpage: { photo: null } })
const videoMedia = () => ({
  className: "MessageMediaDocument",
  document: { attributes: [{ className: "DocumentAttributeVideo" }] },
})
const animatedMedia = () => ({
  className: "MessageMediaDocument",
  document: { attributes: [{ className: "DocumentAttributeAnimated" }] },
})
const audioMedia = (voice: boolean) => ({
  className: "MessageMediaDocument",
  document: { attributes: [{ className: "DocumentAttributeAudio", voice }] },
})
const stickerMedia = () => ({
  className: "MessageMediaDocument",
  document: { attributes: [{ className: "DocumentAttributeSticker" }] },
})
const documentMedia = () => ({
  className: "MessageMediaDocument",
  document: { attributes: [{ className: "DocumentAttributeFilename", fileName: "report.pdf" }] },
})
const pollMedia = (question = "Q?", answers = ["A", "B"]) => ({
  className: "MessageMediaPoll",
  poll: { question, answers: answers.map((text) => ({ text })) },
})

/** Album message: same groupedId, id ascending = older → newer. */
function albumMessage(id: number, groupedId: string, overrides: Partial<DuckMessage> = {}): DuckMessage {
  return makeMessage({ id, groupedId, ...overrides })
}

// ---------------------------------------------------------------------------
// AC-1 / EC-1 — splitMessages
// ---------------------------------------------------------------------------

describe("splitMessages — unit grouping (AC-1, EC-1)", () => {
  it("AC-1: groups album members sorted ascending by id and preserves first-appearance unit order", () => {
    // Scrambled album [302, 300, 301] plus a trailing single.
    const units = splitMessages([
      albumMessage(302, "g1"),
      albumMessage(300, "g1"),
      makeMessage({ id: 400, groupedId: null }),
      albumMessage(301, "g1"),
    ])

    expect(units).toHaveLength(2)
    expect(units[0].kind).toBe("album")
    expect((units[0] as { messages: DuckMessage[] }).messages.map((m) => m.id)).toEqual([300, 301, 302])
    expect(units[1].kind).toBe("single")
    expect((units[1] as { message: DuckMessage }).message.id).toBe(400)
  })

  it("AC-1: keeps an album whose member was deleted (an id gap) — the post exists on Telegram without it — and never repeats touched ids", () => {
    const units = splitMessages([
      makeMessage({ id: 500, groupedId: null }),
      albumMessage(203, "g9"),
      albumMessage(201, "g9"), // 202 deleted by the channel admin
      albumMessage(601, "g10"),
      albumMessage(600, "g10"),
    ])

    expect(units.map((u) => u.kind)).toEqual(["single", "album", "album"])

    const touchedIds = units.flatMap((u) =>
      u.kind === "album" ? u.messages.map((m) => m.id) : [u.message.id]
    )
    expect(touchedIds).toEqual([500, 201, 203, 600, 601])
  })

  it("EC-1: returns [] for empty input and one single unit for one ungrouped message", () => {
    expect(splitMessages([])).toEqual([])

    const units = splitMessages([makeMessage({ id: 9, groupedId: null })])
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe("single")
    expect((units[0] as { message: DuckMessage }).message.id).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// AC-2 — mediaPlaceholder
// ---------------------------------------------------------------------------

describe("mediaPlaceholder — media classes (AC-2)", () => {
  const cases: Array<[string, unknown, string | null]> = [
    ["MessageMediaPhoto", photoMedia(), "[Photo]"],
    ["MessageMediaWebPage with photo", webpagePhotoMedia(), "[Photo]"],
    ["MessageMediaWebPage without photo", webpageLinkMedia(), "[Link]"],
    ["MessageMediaDocument + DocumentAttributeVideo", videoMedia(), "[Video]"],
    ["MessageMediaDocument + DocumentAttributeAnimated", animatedMedia(), "[GIF]"],
    ["MessageMediaDocument + DocumentAttributeAudio voice", audioMedia(true), "[Voice message]"],
    ["MessageMediaDocument + DocumentAttributeAudio music", audioMedia(false), "[Audio]"],
    ["MessageMediaDocument + DocumentAttributeSticker", stickerMedia(), "[Sticker]"],
    // A Telegram GIF is an mp4 carrying BOTH Animated and Video; a video
    // sticker is a webm carrying both Sticker and Video. The narrower kind wins.
    [
      "GIF (Animated + Video)",
      {
        className: "MessageMediaDocument",
        document: {
          attributes: [{ className: "DocumentAttributeVideo" }, { className: "DocumentAttributeAnimated" }],
        },
      },
      "[GIF]",
    ],
    [
      "video sticker (Sticker + Video)",
      {
        className: "MessageMediaDocument",
        document: {
          attributes: [{ className: "DocumentAttributeVideo" }, { className: "DocumentAttributeSticker" }],
        },
      },
      "[Sticker]",
    ],
    ["MessageMediaDocument (other)", documentMedia(), "[Document]"],
    ["MessageMediaPoll", pollMedia(), "[Опрос] Q?\n1. A\n2. B"],
    ["MessageMediaGeo", { className: "MessageMediaGeo" }, "[Location]"],
    ["MessageMediaGeoLive", { className: "MessageMediaGeoLive" }, "[Location]"],
    ["MessageMediaVenue", { className: "MessageMediaVenue" }, "[Venue]"],
    ["MessageMediaContact", { className: "MessageMediaContact" }, "[Contact]"],
    ["MessageMediaDice", { className: "MessageMediaDice" }, "[Dice]"],
    ["no media", null, null],
    ["unknown media class", { className: "MessageMediaUnsupported" }, null],
  ]

  it.each(cases)("AC-2: %s → %s", (_label, media, expected) => {
    expect(mediaPlaceholder(makeMessage({ media }))).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// AC-3 / EC-2 — messageContent
// ---------------------------------------------------------------------------

describe("messageContent (AC-3, EC-2)", () => {
  it("AC-3: returns the raw message text with its entities when text is non-empty", () => {
    const entities = [{ className: "MessageEntityBold", offset: 0, length: 5 }]
    const message = makeMessage({ message: "Hello bold", entities })

    expect(messageContent(message)).toEqual({ content: "Hello bold", contentEntities: entities })
  })

  it("AC-3: appends poll text after the text separated by one blank line, keeping text entities", () => {
    const entities = [{ className: "MessageEntityBold", offset: 0, length: 7 }]
    const message = makeMessage({ message: "Выберите", entities, media: pollMedia() })

    expect(messageContent(message)).toEqual({
      content: "Выберите\n\n[Опрос] Q?\n1. A\n2. B",
      contentEntities: entities,
    })
  })

  it("AC-3: with no text falls back to poll text, then media placeholder, then [Media message] — no entities", () => {
    expect(messageContent(makeMessage({ message: "", media: pollMedia() }))).toEqual({
      content: "[Опрос] Q?\n1. A\n2. B",
      contentEntities: undefined,
    })
    expect(messageContent(makeMessage({ message: "", media: photoMedia() }))).toEqual({
      content: "[Photo]",
      contentEntities: undefined,
    })
    expect(messageContent(makeMessage({ message: "", media: null }))).toEqual({
      content: "[Media message]",
      contentEntities: undefined,
    })
  })

  it("EC-2: photo with empty text → [Photo]; poll with text → starts with 'Выберите\\n\\n[Опрос]'", () => {
    expect(messageContent(makeMessage({ message: "", media: photoMedia() })).content).toBe("[Photo]")
    expect(messageContent(makeMessage({ message: "Выберите", media: pollMedia() })).content).toBe(
      "Выберите\n\n[Опрос] Q?\n1. A\n2. B"
    )
  })
})

// ---------------------------------------------------------------------------
// AC-4 / ERR-1 — buildSingleItem
// ---------------------------------------------------------------------------

describe("buildSingleItem (AC-4, ERR-1)", () => {
  const text = "Goodbye per-seat pricing.\n\nPer-user pricing has always rubbed me the wrong way."
  const entities = [{ className: "MessageEntityBold", offset: 0, length: 7 }]

  it("AC-4: builds url/externalId/publishedAt/mediaUrls/thumbnailUrl/title from the raw text", () => {
    const message = makeMessage({
      id: 42,
      message: text,
      entities,
      media: photoMedia(),
      date: 1_700_000_000,
    })
    const media: MediaResultLike = {
      url: "https://cdn.example.com/photo.jpg",
      type: "photo",
      thumbUrl: "https://cdn.example.com/photo-thumb.jpg",
      skipped: false,
    }

    const item = buildSingleItem(message, "design_digest", media)

    expect(item.url).toBe("https://t.me/design_digest/42")
    expect(item.externalId).toBe("design_digest:42")
    expect(item.publishedAt).toBe(new Date(1_700_000_000 * 1000).toISOString())
    expect(item.content).toBe(text)
    expect(item.contentEntities).toEqual(entities)
    expect(item.mediaUrls).toEqual(["https://cdn.example.com/photo.jpg"])
    expect(item.thumbnailUrl).toBe("https://cdn.example.com/photo-thumb.jpg")
    expect(item.title).toBe("Goodbye per-seat pricing.")
    expect(item.messageId).toBe(42)
    expect(item.channelUsername).toBe("design_digest")
  })

  it("AC-4: uses the 'Post from @username' fallback title and [] mediaUrls when media is absent", () => {
    const message = makeMessage({ id: 7, message: "", media: photoMedia(), date: 1_700_000_000 })

    const item = buildSingleItem(message, "ch", null)

    expect(item.title).toBe("Post from @ch")
    expect(item.mediaUrls).toEqual([])
    expect(item.thumbnailUrl).toBeUndefined()
    expect(item.content).toBe("[Photo]")
  })

  it("ERR-1: never throws on a malformed message and returns the documented fallbacks", () => {
    const malformed = { id: 5, message: undefined, media: null, groupedId: null } as unknown

    let item: Record<string, unknown> | undefined
    expect(() => {
      item = buildSingleItem(malformed, "ch", null)
    }).not.toThrow()

    expect(item!.content).toBe("[Media message]")
    expect(item!.mediaUrls).toEqual([])
    expect(item!.thumbnailUrl).toBeUndefined()
    expect(item!.publishedAt).toBeNull()
    expect(item!.url).toBe("https://t.me/ch/5")
  })
})

// ---------------------------------------------------------------------------
// AC-5 / ERR-1 — buildAlbumItem
// ---------------------------------------------------------------------------

describe("buildAlbumItem (AC-5, ERR-1)", () => {
  it("AC-5: collects non-null mediaUrls ascending by member id, photo thumbnail, max-id identity, content from first text", () => {
    // Scrambled group: input order is [302 (video), 301 (photo), 303 (null url)].
    const text = "Goodbye per-seat pricing."
    const textEntities = [{ className: "MessageEntityBold", offset: 0, length: 7 }]
    const group = [
      albumMessage(302, "g1", { message: text, entities: textEntities, date: 1_700_000_002 }),
      albumMessage(301, "g1", { message: "", media: photoMedia(), date: 1_700_000_001 }),
      albumMessage(303, "g1", { message: "", media: null, date: 1_700_000_003 }),
    ]
    // results parallel to group input order
    const results: MediaResultLike[] = [
      { url: "https://cdn.example.com/video.mp4", type: "video", thumbUrl: "https://cdn.example.com/video-thumb.jpg", skipped: false },
      { url: "https://cdn.example.com/photo.jpg", type: "photo", thumbUrl: "https://cdn.example.com/photo-thumb.jpg", skipped: false },
      { url: null, type: null, thumbUrl: null, skipped: true },
    ]

    const item = buildAlbumItem(group, "ch", results)

    // ascending member id: 301 → photo, 302 → video, 303 → null (dropped)
    expect(item.mediaUrls).toEqual([
      "https://cdn.example.com/photo.jpg",
      "https://cdn.example.com/video.mp4",
    ])
    expect(item.thumbnailUrl).toBe("https://cdn.example.com/photo-thumb.jpg")
    expect(item.url).toBe("https://t.me/ch/303")
    expect(item.externalId).toBe("ch:303")
    expect(item.messageId).toBe(303)
    expect(item.publishedAt).toBe(new Date(1_700_000_003 * 1000).toISOString())
    expect(item.content).toBe(text)
    expect(item.contentEntities).toEqual(textEntities)
    expect(item.title).toBe("Goodbye per-seat pricing.")
  })

  it("AC-5: falls back to the first member's media placeholder and its non-null thumbUrl when no member has text", () => {
    const group = [albumMessage(10, "g", { message: "", media: videoMedia(), date: 1_700_000_010 })]
    const results: MediaResultLike[] = [
      { url: "https://cdn.example.com/v.mp4", type: "video", thumbUrl: "https://cdn.example.com/poster.jpg", skipped: false },
    ]

    const item = buildAlbumItem(group, "ch", results)

    expect(item.content).toBe("[Video]")
    expect(item.title).toBe("Album from @ch")
    expect(item.mediaUrls).toEqual(["https://cdn.example.com/v.mp4"])
    expect(item.thumbnailUrl).toBe("https://cdn.example.com/poster.jpg")
  })

  it("ERR-1: never throws on a malformed group/results and returns the documented fallbacks", () => {
    const group = [{ id: 42, groupedId: "g" }] as unknown[]
    const results: MediaResultLike[] = [{ url: null, type: null, thumbUrl: null, skipped: true }]

    let item: Record<string, unknown> | undefined
    expect(() => {
      item = buildAlbumItem(group, "ch", results)
    }).not.toThrow()

    expect(item!.content).toBe("[Media album]")
    expect(item!.mediaUrls).toEqual([])
    expect(item!.thumbnailUrl).toBeUndefined()
    expect(item!.publishedAt).toBeNull()
    expect(item!.url).toBe("https://t.me/ch/42")
  })
})

// ---------------------------------------------------------------------------
// AC-6 — needsBoundaryFetch
// ---------------------------------------------------------------------------

describe("needsBoundaryFetch (AC-6)", () => {
  it("AC-6: true exactly when input is non-empty and its last (oldest) message has a groupedId", () => {
    expect(needsBoundaryFetch([])).toBe(false)
    expect(needsBoundaryFetch([makeMessage({ id: 1, groupedId: null })])).toBe(false)
    expect(
      needsBoundaryFetch([
        makeMessage({ id: 2, groupedId: "g1" }),
        makeMessage({ id: 1, groupedId: null }),
      ])
    ).toBe(false)
    expect(
      needsBoundaryFetch([
        makeMessage({ id: 2, groupedId: null }),
        makeMessage({ id: 1, groupedId: "g1" }),
      ])
    ).toBe(true)
  })
})

describe("boundaryAlbumMembers", () => {
  it("takes only the cut album's missing members from the older page — never the unrelated posts around it", () => {
    const fetched = [makeMessage({ id: 110, groupedId: null }), albumMessage(102, "g1"), albumMessage(101, "g1")]
    const older = [
      albumMessage(100, "g1"),
      albumMessage(99, "g1"),
      makeMessage({ id: 98, groupedId: null }), // an older post outside the window
      albumMessage(97, "g0"), // an older album outside the window
    ]

    expect(boundaryAlbumMembers(fetched, older).map((m) => m.id)).toEqual([100, 99])
  })

  it("returns nothing when the oldest fetched message is not in an album, or the page repeats known ids", () => {
    expect(boundaryAlbumMembers([makeMessage({ id: 5, groupedId: null })], [albumMessage(4, "g1")])).toEqual([])
    expect(boundaryAlbumMembers([albumMessage(5, "g1")], [albumMessage(5, "g1")])).toEqual([])
  })
})

describe("mirrorUnits", () => {
  it("mirrors every unit's messages in ONE call, in unit order, and hands each unit its own slice", async () => {
    const units = splitMessages([
      makeMessage({ id: 10, groupedId: null, media: videoMedia() }),
      albumMessage(8, "g1"),
      albumMessage(7, "g1"),
      makeMessage({ id: 6, groupedId: null, message: "text" }),
    ])
    const calls: number[][] = []
    const mirrored = await mirrorUnits(units, async (messages) => {
      calls.push(messages.map((m) => m.id))
      return messages.map((m) => ({ url: `u${m.id}`, type: "photo", thumbUrl: null, skipped: false }))
    })

    expect(calls).toEqual([[10, 7, 8, 6]])
    expect(mirrored.map(({ results }) => results.map((r) => r?.url))).toEqual([["u10"], ["u7", "u8"], ["u6"]])
    expect(mirrored.map(({ unit }) => unit)).toEqual(units)
  })

  it("leaves a unit's results null when the mirror returned none for it", async () => {
    const units = splitMessages([makeMessage({ id: 1, groupedId: null }), makeMessage({ id: 2, groupedId: null })])
    const mirrored = await mirrorUnits(units, async (messages) => [
      { url: "u1", type: "photo", thumbUrl: null, skipped: false },
      ...messages.slice(1).map(() => null),
    ])
    expect(mirrored.map(({ results }) => results)).toEqual([
      [{ url: "u1", type: "photo", thumbUrl: null, skipped: false }],
      [null],
    ])
  })
})

// ---------------------------------------------------------------------------
// AC-7 — createMediaBudget
// ---------------------------------------------------------------------------

describe("createMediaBudget (AC-7)", () => {
  it("AC-7: hasTime is true before the deadline and false at/after, stable across repeated calls", () => {
    let t = 0
    const budget = createMediaBudget(1000, () => t)

    expect(budget.hasTime()).toBe(true)
    expect(budget.hasTime()).toBe(true)

    t = 999
    expect(budget.hasTime()).toBe(true)

    t = 1000
    expect(budget.hasTime()).toBe(false)
    expect(budget.hasTime()).toBe(false)

    t = 1001
    expect(budget.hasTime()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// cleanChannelUsername — source-URL forms (RAD-359)
// ---------------------------------------------------------------------------

describe("cleanChannelUsername", () => {
  it("strips the web-preview s/ segment, the protocol, @ and any path", () => {
    expect(cleanChannelUsername("https://t.me/s/eaccrussia")).toBe("eaccrussia")
    expect(cleanChannelUsername("https://t.me/eaccrussia/42")).toBe("eaccrussia")
    expect(cleanChannelUsername("t.me/s/awdee")).toBe("awdee")
    expect(cleanChannelUsername("@eaccrussia")).toBe("eaccrussia")
    expect(cleanChannelUsername(" eaccrussia/ ")).toBe("eaccrussia")
  })
})
