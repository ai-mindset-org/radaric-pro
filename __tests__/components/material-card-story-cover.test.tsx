/**
 * @vitest-environment jsdom
 */

/**
 * RAD-399 — a story card's cover is a gallery of every member post's images.
 *
 * The list builds the frames (`storyGalleryImages`) and hands them to the card
 * as `cover`; the card renders exactly what it is given. Without `cover` the
 * card keeps deriving its band from its own `material`, as every post card
 * does. Harness copied from material-card-open.test.tsx — the real card, a
 * stubbed router.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

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

import { MaterialCard } from "@/components/materials/material-card"

const M1 = "https://cdn.example.com/own-1.jpg"
const M2 = "https://cdn.example.com/own-2.jpg"
const U1 = "https://cdn.example.com/u1.jpg"
const U2 = "https://cdn.example.com/u2.jpg"
const U3 = "https://cdn.example.com/u3.jpg"

const STORY = {
  id: "story-1",
  title: "A story",
  summary: "s",
  rubrics: [],
  sourceUrls: [],
  status: "DRAFT",
  version: 1,
  createdAt: "2026-09-10T14:52:00Z",
}

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    title: "Primary member",
    url: "https://example.com/post",
    content: "Plain body copy.",
    publishedAt: new Date("2026-09-09T20:59:00Z"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 82,
    userStatus: "NEW" as const,
    feed: { id: "feed-1", name: "Feed", type: "RSS" as const },
    feedbacks: [],
    ...overrides,
  }
}

function band() {
  return document.querySelector(".surface-mask-top") as HTMLElement | null
}

/**
 * Every frame the cover band carries, cover first. Extra frames mount only once
 * the gallery is armed, so arm it with a pointer enter first.
 */
function bandFrames(): string[] {
  const el = band()
  if (!el) return []
  const scrub = el.querySelector("img")?.parentElement
  if (scrub) fireEvent.pointerEnter(scrub)
  return Array.from(el.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "")
}

afterEach(cleanup)

describe("MaterialCard story cover (RAD-399)", () => {
  it("AC-5: renders exactly the frames passed in `cover`, not the material's own", () => {
    render(
      <MaterialCard
        material={material({ thumbnailUrl: M1, mediaUrls: [M1, M2] })}
        story={STORY}
        cover={{ images: [U1, U2, U3], hasVideo: false }}
      />
    )

    expect(screen.getByRole("img", { name: /image 1 of 3/i })).toHaveAttribute("src", U1)
    expect(bandFrames()).toEqual([U1, U2, U3])
  })

  it("AC-5: without `cover` the card renders its material's own gallery as today", () => {
    render(<MaterialCard material={material({ thumbnailUrl: M1, mediaUrls: [M1, M2] })} />)

    expect(screen.getByRole("img", { name: /image 1 of 2/i })).toHaveAttribute("src", M1)
    expect(bandFrames()).toEqual([M1, M2])
  })

  it("AC-6: `cover.hasVideo: true` renders the play badge even when the material has no media", () => {
    const { container } = render(
      <MaterialCard
        material={material()}
        story={STORY}
        cover={{ images: [U1], hasVideo: true }}
      />
    )

    expect(container.querySelectorAll("[data-video-badge]")).toHaveLength(1)
    expect(bandFrames()).toEqual([U1])
  })

  it("AC-6: `cover.hasVideo: false` renders no badge even when the material itself has a video", () => {
    const own = material({
      thumbnailUrl: "https://cdn.example.com/poster.jpg",
      mediaUrls: ["https://cdn.example.com/reel.mp4"],
    })
    const { container } = render(
      <MaterialCard
        material={own}
        story={STORY}
        cover={{ images: [U1], hasVideo: false }}
      />
    )

    expect(container.querySelectorAll("[data-video-badge]")).toHaveLength(0)
    expect(bandFrames()).toEqual([U1])
  })

  it("EC-1: an empty `cover` renders no band, even when the material has an image of its own", () => {
    render(
      <MaterialCard
        material={material({ thumbnailUrl: M1, mediaUrls: [M1] })}
        story={STORY}
        cover={{ images: [], hasVideo: false }}
      />
    )

    expect(band()).toBeNull()
  })
})
