/**
 * `lib/story-aggregator/media-backfill` (RAD-359 P5) — media reconciliation for
 * posts stored before the Telegram media mirror existed.
 *
 * `computeMediaBackfill` is pure — inputs in, output out. No mocks, no DB.
 */

import { describe, it, expect } from "vitest"
import { computeMediaBackfill } from "@/lib/story-aggregator/media-backfill"

interface MediaBackfillInput {
  url?: string
  externalId?: string
  thumbnailUrl?: string | null
  mediaUrls: string[]
  content: string
}

interface MediaBackfillPayload {
  thumbnailUrl: string | null
  mediaUrls: string[]
  content: string
}

function existing(overrides: Partial<MediaBackfillInput> = {}): MediaBackfillInput {
  return {
    url: "https://t.me/ch/1",
    externalId: "ch:1",
    thumbnailUrl: null,
    mediaUrls: [],
    content: "[Media message]",
    ...overrides,
  }
}

function fresh(overrides: Partial<MediaBackfillInput> = {}): MediaBackfillInput {
  return {
    url: "https://t.me/ch/1",
    externalId: "ch:1",
    thumbnailUrl: null,
    mediaUrls: [],
    content: "Real text",
    ...overrides,
  }
}

describe("computeMediaBackfill — media superset reconciliation (RAD-359 AC-1, AC-2, EC-1, EC-2)", () => {
  it("AC-1: returns a payload when existing media is empty and fresh carries media", () => {
    const payload: MediaBackfillPayload | null = computeMediaBackfill(
      existing({ mediaUrls: [], thumbnailUrl: null, content: "[Media message]" }),
      fresh({
        mediaUrls: ["https://cdn/x/v.mp4"],
        thumbnailUrl: "https://cdn/x/thumb.jpg",
        content: "Real text",
      })
    )

    expect(payload).toEqual({
      thumbnailUrl: "https://cdn/x/thumb.jpg",
      mediaUrls: ["https://cdn/x/v.mp4"],
      content: "Real text",
    })
  })

  it("AC-1 / AC-2: returns a payload for a strict superset, preferring fresh non-null thumb and keeping real existing content", () => {
    const payload: MediaBackfillPayload | null = computeMediaBackfill(
      existing({
        mediaUrls: ["https://cdn/a.jpg"],
        thumbnailUrl: "https://cdn/old.jpg",
        content: "Existing real text",
      }),
      fresh({
        mediaUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"],
        thumbnailUrl: null,
        content: "Fresh real text",
      })
    )

    expect(payload).toEqual({
      thumbnailUrl: "https://cdn/old.jpg",
      mediaUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"],
      content: "Existing real text",
    })
  })

  it("EC-1: returns null for equal sets and when fresh is missing an existing URL (never shrink an album)", () => {
    expect(
      computeMediaBackfill(
        existing({ mediaUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"] }),
        fresh({ mediaUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"] })
      )
    ).toBeNull()

    expect(
      computeMediaBackfill(
        existing({ mediaUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"] }),
        fresh({ mediaUrls: ["https://cdn/a.jpg"] })
      )
    ).toBeNull()
  })

  it("EC-2: never produces a payload when fresh.mediaUrls is empty", () => {
    expect(
      computeMediaBackfill(existing({ mediaUrls: [] }), fresh({ mediaUrls: [] }))
    ).toBeNull()

    expect(
      computeMediaBackfill(
        existing({ mediaUrls: ["https://cdn/a.jpg"] }),
        fresh({ mediaUrls: [] })
      )
    ).toBeNull()
  })

  it("AC-2: prefers fresh.thumbnailUrl when non-null, else keeps existing.thumbnailUrl", () => {
    const freshWins = computeMediaBackfill(
      existing({ mediaUrls: [], thumbnailUrl: "https://cdn/old.jpg" }),
      fresh({ mediaUrls: ["https://cdn/a.jpg"], thumbnailUrl: "https://cdn/new.jpg" })
    )
    expect(freshWins).toEqual({
      thumbnailUrl: "https://cdn/new.jpg",
      mediaUrls: ["https://cdn/a.jpg"],
      content: "Real text",
    })

    const existingKept = computeMediaBackfill(
      existing({ mediaUrls: [], thumbnailUrl: "https://cdn/old.jpg" }),
      fresh({ mediaUrls: ["https://cdn/a.jpg"], thumbnailUrl: null })
    )
    expect(existingKept).toEqual({
      thumbnailUrl: "https://cdn/old.jpg",
      mediaUrls: ["https://cdn/a.jpg"],
      content: "Real text",
    })
  })

  it("AC-2: upgrades content to fresh real text only from the two media placeholders", () => {
    const fromMessage = computeMediaBackfill(
      existing({ mediaUrls: [], content: "[Media message]" }),
      fresh({ mediaUrls: ["https://cdn/a.jpg"], content: "Real text" })
    )
    expect(fromMessage).toEqual({
      thumbnailUrl: null,
      mediaUrls: ["https://cdn/a.jpg"],
      content: "Real text",
    })

    const fromAlbum = computeMediaBackfill(
      existing({ mediaUrls: [], content: "[Media album]" }),
      fresh({ mediaUrls: ["https://cdn/a.jpg"], content: "Real album text" })
    )
    expect(fromAlbum).toEqual({
      thumbnailUrl: null,
      mediaUrls: ["https://cdn/a.jpg"],
      content: "Real album text",
    })
  })

  it("AC-2: preserves existing content when it is already real text, or when fresh is still a placeholder", () => {
    const realExisting = computeMediaBackfill(
      existing({ mediaUrls: [], content: "Existing real text" }),
      fresh({ mediaUrls: ["https://cdn/a.jpg"], content: "Fresh real text" })
    )
    expect(realExisting).toEqual({
      thumbnailUrl: null,
      mediaUrls: ["https://cdn/a.jpg"],
      content: "Existing real text",
    })

    const placeholderFresh = computeMediaBackfill(
      existing({ mediaUrls: [], content: "[Media message]" }),
      fresh({ mediaUrls: ["https://cdn/a.jpg"], content: "[Media album]" })
    )
    expect(placeholderFresh).toEqual({
      thumbnailUrl: null,
      mediaUrls: ["https://cdn/a.jpg"],
      content: "[Media message]",
    })
  })
})

describe("computeMediaBackfill — legacy tg:// markers (RAD-359 review fix)", () => {
  it("treats a stored tg:// placeholder as no media and lets the fresh real URL replace it", () => {
    const payload = computeMediaBackfill(
      { mediaUrls: ["tg://photo/77"], content: "[Media message]" },
      { mediaUrls: ["https://cdn.example/telegram/ch/77.jpg"], content: "Real text" }
    )
    expect(payload).toEqual({
      thumbnailUrl: null,
      mediaUrls: ["https://cdn.example/telegram/ch/77.jpg"],
      content: "Real text",
    })
  })

  it("is idempotent for an oversized post: a stored too-large marker that the fresh parse repeats writes nothing", () => {
    const marker = "tg://too-large/ch/77"
    const poster = "https://cdn.example/telegram/ch/77_thumb.jpg"
    // First parse after the feature: the empty row gains the marker + poster.
    expect(
      computeMediaBackfill(
        { mediaUrls: [], thumbnailUrl: null, content: "[Media message]" },
        { mediaUrls: [marker], thumbnailUrl: poster, content: "[Video]" }
      )
    ).not.toBeNull()
    // Every later parse returns the same marker — no rewrite, no event.
    expect(
      computeMediaBackfill(
        { mediaUrls: [marker], thumbnailUrl: poster, content: "[Media message]" },
        { mediaUrls: [marker], thumbnailUrl: poster, content: "[Video]" }
      )
    ).toBeNull()
  })

  it("still backfills a poster that arrives on a later parse for the same marker", () => {
    const marker = "tg://too-large/ch/78"
    const poster = "https://cdn.example/telegram/ch/78_thumb.jpg"
    expect(
      computeMediaBackfill(
        { mediaUrls: [marker], thumbnailUrl: null, content: "[Video]" },
        { mediaUrls: [marker], thumbnailUrl: poster, content: "[Video]" }
      )
    ).toEqual({ thumbnailUrl: poster, mediaUrls: [marker], content: "[Video]" })
  })
})
