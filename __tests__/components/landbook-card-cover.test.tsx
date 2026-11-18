/**
 * @vitest-environment jsdom
 */

/**
 * RAD-432 — a Land Book post card paints the featured site's full-page
 * screenshot, not Landbook's branded social card.
 *
 * The stored shape is the one in the production DB: the parser saved the
 * article's `og:image` (the branded card) as `thumbnailUrl`, and the item's own
 * screenshot sits in `mediaUrls` under a URL that names no file extension.
 * Harness copied from material-card-story-cover.test.tsx.
 */

import { describe, it, expect, vi, beforeAll } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render } from "@testing-library/react"

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

const SHOT =
  "https://cdn.land-book.com/image/0x0:2880x4320/600x0/filters:format(jpeg)/website/101866/064f02c349173549-screenshot-upload?signature=231e37a0c270e40ebc09ad2b54802f234eb10356aebeec7a558acf124a8294b4"
const OG_CARD =
  "https://cdn.land-book.com/website/101866/101866-doko-studio-branding-software-and-cybersecurity-1793868978-og-image.webp"
/** The same shot as the article page re-serves it, and the og-media twin. */
const ART_2880 =
  "https://cdn.land-book.com/image/0x0:2880x2870/2880x0/filters:format(webp)/website/101866/064f02c349173549-screenshot-upload?signature=47da2ec4b231a7a69e72793e011f2923c5d4ade02e986455e6a6e17b8427bf41"
const ART_600 =
  "https://cdn.land-book.com/image/0x0:2880x2870/600x0/filters:format(webp)/website/101866/064f02c349173549-screenshot-upload?signature=b8e96695f6777abdb87dea9b86e8446784bf53358174c4b6cefb8c7bf13afffb"
const OG_MEDIA =
  "https://storage.land-book.com/website/101866/og-media/352d90583360bbc1-og-media.webp"

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    title: "▷ Doko Studio | Branding, software and cybersecurity",
    url: "https://land-book.com/websites/101866-doko-studio",
    content: "Portfolio site on Landbook.",
    publishedAt: new Date("2026-11-04T09:15:00Z"),
    thumbnailUrl: OG_CARD,
    mediaUrls: [OG_CARD, SHOT, ART_2880, ART_600, OG_MEDIA],
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 82,
    userStatus: "NEW" as const,
    feed: { id: "feed-1", name: "Land Book", type: "RSS" as const },
    feedbacks: [],
    ...overrides,
  }
}

function coverSrc(): string | null | undefined {
  return document.querySelector(".surface-mask-top img")?.getAttribute("src")
}

describe("Land Book post card cover (RAD-432)", () => {
  it("paints the full-page screenshot when the stored cover is the branded card", () => {
    render(<MaterialCard material={material()} />)
    expect(coverSrc()).toBe(SHOT)
  })

  it("offers no second frame, so a hover cannot scrub onto the branded card", () => {
    render(<MaterialCard material={material()} />)
    // One frame → a still, not the hover gallery.
    expect(document.querySelector(".surface-mask-top img")).toBeTruthy()
    expect(document.querySelectorAll(".surface-mask-top img")).toHaveLength(1)
  })

  it("leaves a card whose material has no screenshot alone", () => {
    render(<MaterialCard material={material({ mediaUrls: [OG_CARD] })} />)
    expect(coverSrc()).toBe(OG_CARD)
  })
})
