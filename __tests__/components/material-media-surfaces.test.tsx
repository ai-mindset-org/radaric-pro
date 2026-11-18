/** @vitest-environment jsdom */

/**
 * RAD-359 P4 — the media surfaces that were still rendering every URL as an
 * `<img>`:
 *
 *   - `CardCover` gains an optional video badge that must survive a failed
 *     cover (the band used to return `null`, taking any badge with it).
 *   - `MaterialCard` shows that badge exactly when the cover is a video poster.
 *   - `StoryArticle` routes each inbox media entry through `MaterialMedia`, so a
 *     video/audio is not wrapped in a link and a document is a file link.
 *
 * jsdom has no layout, so the badge is located by its `data-video-badge` hook
 * and asserted by attribute, not by position.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

import { CardCover } from "@/components/ui/card-cover"
import { MaterialCard } from "@/components/materials/material-card"
import { StoryArticle } from "@/components/stories/story-article"

const COVER = "https://x/cover.jpg"
const REEL = "https://x/reel.mp4"
const IMAGE = "https://x/a.jpg"
const AUDIO = "https://x/voice.ogg"
const DOCUMENT = "https://x/report.pdf"

afterEach(cleanup)

/** The badge hook every surface is queried by (contract 1). */
function videoBadge() {
  return document.querySelector("[data-video-badge]")
}

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    title: "Connectome demos",
    url: "https://t.me/example/12345",
    content: "Plain body copy.",
    publishedAt: new Date("2026-09-09T20:59:00Z"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 82,
    userStatus: "NEW" as const,
    feed: { id: "feed-1", name: "e/acc", type: "TELEGRAM" as const },
    feedbacks: [],
    ...overrides,
  }
}

function storyArticle(mediaUrls: string[]) {
  return {
    id: "story-1",
    title: "A media story",
    languageFlag: null,
    summary: "",
    body: "",
    keyPoints: [],
    sourceUrls: [],
    rubrics: [],
    archiveLinks: null,
    notionPageId: null,
    notionUrl: null,
    status: "DRAFT",
    version: 1,
    createdAt: "2026-09-10T14:52:00Z",
    updatedAt: "2026-09-10T14:52:00Z",
    materials: [],
    inboxItems: [
      {
        id: "inbox-1",
        externalId: "-100:1",
        messageId: 1,
        rawText: null,
        extractedUrl: null,
        extractedTitle: null,
        mediaUrls,
        thumbnailUrl: null,
        sourceChannel: null,
        status: "MATCHED",
        createdAt: "2026-09-10T14:50:00Z",
      },
    ],
  }
}

describe("CardCover — video badge", () => {
  it("AC-2: renders the badge inside the band, aria-hidden and tagged", () => {
    render(<CardCover src={COVER} alt="Post" badge={<span>Video</span>} />)

    const badge = videoBadge()
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute("aria-hidden")).toBe("true")
    expect(badge!.textContent).toBe("Video")
    expect(badge!.closest(".surface-mask-top")).not.toBeNull()
  })

  it("AC-2: a failed cover keeps a muted band carrying the badge, and drops the image", () => {
    render(<CardCover src={COVER} alt="Post" badge={<span>Video</span>} />)

    fireEvent.error(screen.getByRole("img"))

    expect(document.querySelector("img")).toBeNull()
    const badge = videoBadge()
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute("aria-hidden")).toBe("true")
  })

  it("EC-2: without a badge a failed cover still hides the band", () => {
    render(<CardCover src={COVER} alt="Post" />)

    fireEvent.error(screen.getByRole("img"))

    expect(document.querySelector(".surface-mask-top")).toBeNull()
    expect(videoBadge()).toBeNull()
  })
})

describe("MaterialCard — video badge", () => {
  it("AC-3: badges a poster cover, never a photo-cover album or a coverless post", () => {
    // Poster cover: the thumbnail is not one of the mediaUrls frames.
    const video = render(
      <MaterialCard material={material({ thumbnailUrl: COVER, mediaUrls: [REEL] })} />
    )
    expect(videoBadge()).not.toBeNull()
    video.unmount()

    // Mixed album: the cover is its first photo (a frame) — no badge on a photo.
    const photoCover = render(
      <MaterialCard material={material({ thumbnailUrl: COVER, mediaUrls: [COVER, REEL] })} />
    )
    expect(videoBadge()).toBeNull()
    photoCover.unmount()

    const extraImage = render(
      <MaterialCard material={material({ thumbnailUrl: IMAGE, mediaUrls: [IMAGE, REEL] })} />
    )
    expect(videoBadge()).toBeNull()
    extraImage.unmount()

    render(<MaterialCard material={material({ thumbnailUrl: null, mediaUrls: [REEL] })} />)
    expect(videoBadge()).toBeNull()
  })
})

describe("StoryArticle — per-kind inbox media", () => {
  it("AC-4: renders video and audio without a link wrapper, and the image inside its media link", () => {
    render(<StoryArticle story={storyArticle([IMAGE, REEL, AUDIO, DOCUMENT])} actions={[]} />)

    const video = document.querySelector("video")
    expect(video).not.toBeNull()
    expect(video!.closest("a")).toBeNull()

    const audio = document.querySelector("audio")
    expect(audio).not.toBeNull()
    expect(audio!.closest("a")).toBeNull()

    const img = document.querySelector("img")
    expect(img).not.toBeNull()
    expect(img!.closest("a")?.getAttribute("href")).toBe(IMAGE)
  })

  it("AC-4: renders a document entry as its file link", () => {
    render(<StoryArticle story={storyArticle([IMAGE, REEL, AUDIO, DOCUMENT])} actions={[]} />)

    const pdf = screen.getByRole("link", { name: /open\s*pdf/i })
    expect(pdf).toHaveAttribute("href", DOCUMENT)
    expect(pdf).toHaveAttribute("target", "_blank")
  })

  it("ERR-1: an empty media list renders no media block", () => {
    const { container } = render(<StoryArticle story={storyArticle([])} actions={[]} />)

    expect(container.querySelector("video")).toBeNull()
    expect(container.querySelector("audio")).toBeNull()
    expect(container.querySelectorAll("img")).toHaveLength(0)
  })
})
