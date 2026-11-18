/**
 * @vitest-environment jsdom
 */

/**
 * `MaterialMedia` — the one shared renderer for every media kind a reading
 * surface can carry (RAD-359).
 *
 * Before this, each surface rendered a media URL as an `<img>`: a Telegram
 * video painted a broken tile, an audio message vanished, a document was
 * invisible. This component owns the per-kind branch; the tests pin the DOM
 * element and its load-bearing attributes by kind (jsdom has no layout to
 * measure). The module does not exist yet in RED — the import failure is the
 * expected failure.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { MaterialMedia } from "@/components/materials/material-media"

afterEach(cleanup)

const REEL = "https://cdn.example.com/archives/reel.mp4"
const POSTER = "https://cdn.example.com/archives/poster.jpg"

describe("MaterialMedia", () => {
  it("AC-7: renders video with controls, playsinline, preload=metadata and the poster", () => {
    const { container } = render(<MaterialMedia url={REEL} poster={POSTER} alt="Reel" />)

    const video = container.querySelector("video")
    expect(video).not.toBeNull()
    expect(video!.getAttribute("src")).toBe(REEL)
    expect(video!.getAttribute("poster")).toBe(POSTER)
    expect(video!.getAttribute("preload")).toBe("metadata")
    expect(video!.hasAttribute("controls")).toBe(true)
    expect(video!.hasAttribute("playsinline")).toBe(true)
  })

  it("AC-7: renders audio with controls and labels ogg/oga/opus 'Voice message', other files 'Audio'", () => {
    for (const ext of ["ogg", "oga", "opus"]) {
      const url = `https://cdn.example.com/voice/msg.${ext}`
      const { container, unmount } = render(<MaterialMedia url={url} />)
      const audio = container.querySelector("audio")
      expect(audio).not.toBeNull()
      expect(audio!.getAttribute("src")).toBe(url)
      expect(audio!.hasAttribute("controls")).toBe(true)
      expect(screen.getByText("Voice message")).toBeInTheDocument()
      unmount()
    }

    const { container } = render(<MaterialMedia url="https://cdn.example.com/voice/track.mp3" />)
    expect(container.querySelector("audio")).not.toBeNull()
    expect(screen.getByText("Audio")).toBeInTheDocument()
  })

  it("AC-7: renders a document as a new-tab link whose text names the extension", () => {
    const url = "https://files.example.com/2026/report.pdf"
    render(<MaterialMedia url={url} />)

    const link = screen.getByRole("link", { name: /open\s*pdf/i })
    expect(link).toHaveAttribute("href", url)
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("AC-7: renders an image with the given alt, defaulting to the empty string", () => {
    const url = "https://cdn.example.com/photo.jpg"

    const withAlt = render(<MaterialMedia url={url} alt="Hero" />)
    const img = withAlt.container.querySelector("img")
    expect(img).not.toBeNull()
    expect(img!.getAttribute("src")).toBe(url)
    expect(img!.getAttribute("alt")).toBe("Hero")
    withAlt.unmount()

    const withoutAlt = render(<MaterialMedia url={url} />)
    expect(withoutAlt.container.querySelector("img")!.getAttribute("alt")).toBe("")
  })

  it("AC-7: renders an embed URL as a titled iframe", () => {
    const url = "https://youtu.be/abc"
    const { container } = render(<MaterialMedia url={url} />)

    const iframe = container.querySelector("iframe")
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute("src")).toBe(url)
    expect(iframe!.hasAttribute("title")).toBe(true)
  })

  it("RAD-400 AC-12: the embed iframe loads lazily", () => {
    const { container } = render(<MaterialMedia url="https://www.youtube.com/watch?v=abc" />)

    const iframe = container.querySelector("iframe")
    expect(iframe!.getAttribute("src")).toBe("https://www.youtube.com/watch?v=abc")
    expect(iframe!.getAttribute("loading")).toBe("lazy")
  })

  it("AC-7: renders placeholder labels — 'Telegram media' for unresolved, 'not mirrored' + t.me link for too-large", () => {
    const placeholder = render(<MaterialMedia url="tg://photo/123" />)
    expect(screen.getByText("Telegram media")).toBeInTheDocument()
    placeholder.unmount()

    render(<MaterialMedia url="tg://too-large/eaccrussia/123" />)
    expect(screen.getByText(/not mirrored/i)).toBeInTheDocument()
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toBe("https://t.me/eaccrussia/123")
  })

  it("AC-7: renders nothing for an unknown URL", () => {
    const { container } = render(
      <MaterialMedia url="https://mashable.com/article/sora-videos-social-media" />
    )
    expect(container.innerHTML).toBe("")
  })
})
