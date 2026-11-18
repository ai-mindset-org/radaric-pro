/**
 * @vitest-environment jsdom
 */

/**
 * A feed's `coverUrl` is whatever the fetcher found: a channel avatar, an RSS
 * `<image>` logo, a homepage og:image. Only the last is shaped like a cover, so
 * the card decides from the image itself, not from the feed type: a wide,
 * large image is the cover band; anything else — a square logo, a small icon —
 * is the small avatar beside the title, never a logo blown up to column width.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { FeedCard } from "@/components/feeds/feed-card"
import { classifyCoverShape } from "@/lib/cover-shape"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const COVER = "https://example.com/cover.png"

function source(overrides: Partial<React.ComponentProps<typeof FeedCard>["source"]> = {}) {
  return {
    id: "f1",
    type: "RSS" as const,
    url: "https://example.com/feed",
    name: "Example",
    coverUrl: COVER,
    isActive: true,
    status: "ACTIVE" as const,
    ...overrides,
  }
}

function band() {
  return document.querySelector(".surface-mask-top")
}

function avatar() {
  return document.querySelector("[data-feed-avatar]")
}

/** The probe is the only `<img>` with the cover URL before the shape is known. */
function loadAs(width: number, height: number) {
  const probe = document.querySelector(`img[src="${COVER}"]`) as HTMLImageElement
  Object.defineProperty(probe, "naturalWidth", { configurable: true, value: width })
  Object.defineProperty(probe, "naturalHeight", { configurable: true, value: height })
  fireEvent.load(probe)
}

/**
 * A server-rendered image can settle before hydration attaches its handlers,
 * and the event never fires again: the card must read what already happened.
 */
function settledBeforeHydration(width: number, height: number) {
  const proto = HTMLImageElement.prototype
  vi.spyOn(proto, "complete", "get").mockReturnValue(true)
  vi.spyOn(proto, "naturalWidth", "get").mockReturnValue(width)
  vi.spyOn(proto, "naturalHeight", "get").mockReturnValue(height)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("classifyCoverShape", () => {
  it("calls a wide, large image a banner", () => {
    expect(classifyCoverShape(1200, 630)).toBe("banner")
  })

  it("calls a square logo an avatar, however large", () => {
    expect(classifyCoverShape(1400, 1400)).toBe("avatar")
  })

  it("calls a wide image too small to fill a column an avatar", () => {
    expect(classifyCoverShape(200, 60)).toBe("avatar")
  })

  it("calls a portrait image an avatar", () => {
    expect(classifyCoverShape(600, 900)).toBe("avatar")
  })
})

describe("FeedCard cover", () => {
  it("shows neither band nor avatar until the image reports its shape", () => {
    render(<FeedCard source={source()} />)

    expect(band()).toBeNull()
    expect(avatar()).toBeNull()
  })

  it("renders a wide RSS cover as the band", () => {
    render(<FeedCard source={source()} />)
    loadAs(1200, 630)

    expect(band()).not.toBeNull()
    expect(avatar()).toBeNull()
  })

  it("renders a square RSS logo as the small avatar, not a band", () => {
    render(<FeedCard source={source()} />)
    loadAs(1400, 1400)

    expect(band()).toBeNull()
    expect(avatar()).toHaveAttribute("src", COVER)
  })

  it("shows nothing when the cover fails to load", () => {
    render(<FeedCard source={source()} />)
    fireEvent.error(document.querySelector(`img[src="${COVER}"]`)!)

    expect(band()).toBeNull()
    expect(avatar()).toBeNull()
    expect(document.querySelector(`img[src="${COVER}"]`)).toBeNull()
  })

  it("reads a cover that loaded before hydration, without a load event", () => {
    settledBeforeHydration(1200, 630)
    render(<FeedCard source={source()} />)

    expect(band()).not.toBeNull()
  })

  it("drops a cover that failed before hydration, without an error event", () => {
    settledBeforeHydration(0, 0)
    render(<FeedCard source={source()} />)

    expect(band()).toBeNull()
    expect(avatar()).toBeNull()
  })

  it("drops a Telegram avatar that failed before hydration", () => {
    settledBeforeHydration(0, 0)
    render(<FeedCard source={source({ type: "TELEGRAM", url: "https://t.me/x" })} />)

    expect(avatar()).toBeNull()
  })

  it("treats an image with no intrinsic size as failed", () => {
    render(<FeedCard source={source()} />)
    loadAs(0, 0)

    expect(band()).toBeNull()
    expect(avatar()).toBeNull()
  })

  it("measures an edited cover afresh instead of keeping the old verdict", () => {
    const { rerender } = render(<FeedCard source={source()} />)
    loadAs(1200, 630)
    expect(band()).not.toBeNull()

    const LOGO = "https://example.com/logo.png"
    rerender(<FeedCard source={source({ coverUrl: LOGO })} />)
    expect(band()).toBeNull()

    const probe = document.querySelector(`img[src="${LOGO}"]`) as HTMLImageElement
    Object.defineProperty(probe, "naturalWidth", { configurable: true, value: 256 })
    Object.defineProperty(probe, "naturalHeight", { configurable: true, value: 256 })
    fireEvent.load(probe)
    expect(avatar()).toHaveAttribute("src", LOGO)
  })

  it("keeps Telegram and X avatars without measuring them", () => {
    render(<FeedCard source={source({ type: "TELEGRAM", url: "https://t.me/x" })} />)

    expect(band()).toBeNull()
    expect(avatar()).toHaveAttribute("src", COVER)
  })

  it("drops an avatar that fails to load instead of a broken-image icon", () => {
    render(<FeedCard source={source({ type: "TWITTER", url: "https://x.com/x" })} />)
    fireEvent.error(avatar()!)

    expect(avatar()).toBeNull()
  })
})
