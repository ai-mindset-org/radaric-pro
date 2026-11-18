/**
 * @vitest-environment jsdom
 */

/**
 * The media grid under a post's hero on `/posts/[id]`.
 *
 * The cards learned which `mediaUrls` entries are images in #116-#118; this
 * page kept its own inline filter, which only dropped an exact string copy of
 * the cover. A Brand New post whose feed carried `[cover.png, reel.mp4]`
 * rendered a "Media (1)" heading over a broken-image tile, because the `.mp4`
 * went into an `<img>` (2026-09-13). What is pinned here is which frames reach
 * the DOM and whether the heading appears — jsdom has no layout to measure.
 *
 * Contract change (RAD-359): the gallery now renders each kept entry through
 * `MaterialMedia`, so a video becomes a `<video>` and an audio file an
 * `<audio>` instead of being dropped; only unrenderable pages are dropped.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

import { MaterialDetailPage } from "@/components/materials/material-detail-page"

const COVER = "https://brand.example/wp-content/uploads/2026/02/logo.png"
const REEL = "https://brand.example/archives/reel.mp4"
const VOICE = "https://brand.example/archives/voice.ogg"
const SECOND = "https://brand.example/wp-content/uploads/2026/02/poster.jpg"

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "mat-1",
    title: "New Logo and Identity",
    url: "https://brand.example/post",
    content: "Plain body copy.",
    publishedAt: new Date("2026-02-19T13:55:00Z"),
    thumbnailUrl: COVER,
    mediaUrls: [COVER, REEL],
    aiEvaluation: "FILTERED" as const,
    aiConfidence: 95,
    aiReasoning: null,
    userStatus: "NEW" as const,
    feed: { id: "feed-1", name: "Brand New", type: "RSS" as const },
    feedbacks: [],
    ...overrides,
  }
}

function imageSources() {
  return screen.getAllByRole("img").map((img) => img.getAttribute("src"))
}

afterEach(cleanup)

describe("MaterialDetailPage media gallery", () => {
  it("AC-8: renders an extra video file as a player, not a broken image", () => {
    render(<MaterialDetailPage material={material()} />)

    expect(screen.getByText("Media (1)")).toBeInTheDocument()
    expect(imageSources()).toEqual([COVER])
    const video = document.querySelector("video")
    expect(video).not.toBeNull()
    expect(video).toHaveAttribute("src", REEL)
  })

  it("AC-8: counts and renders every kept entry — images, video and audio — dropping only the cover's twin and a page link", () => {
    render(
      <MaterialDetailPage
        material={material({
          mediaUrls: [
            `https://i0.wp.com/brand.example/wp-content/uploads/2026/02/logo.png?resize=960`,
            SECOND,
            REEL,
            VOICE,
            "https://news.example/2026/09/some-article",
          ],
        })}
      />
    )

    expect(screen.getByText("Media (3)")).toBeInTheDocument()
    expect(imageSources()).toEqual([COVER, SECOND])
    expect(document.querySelector("video")).toHaveAttribute("src", REEL)
    expect(document.querySelector("audio")).toHaveAttribute("src", VOICE)
  })

  it("a Telegram video post plays in the hero, on its poster — the poster is not painted twice", () => {
    const POSTER = "https://cdn.example/telegram/ch/5_thumb.jpg"
    const VIDEO = "https://cdn.example/telegram/ch/5.mp4"
    render(
      <MaterialDetailPage
        material={material({
          thumbnailUrl: POSTER,
          mediaUrls: [VIDEO],
          feed: { id: "feed-tg", name: "e/acc", type: "TELEGRAM" as const },
        })}
      />
    )

    const videos = document.querySelectorAll("video")
    expect(videos).toHaveLength(1)
    expect(videos[0]).toHaveAttribute("src", VIDEO)
    expect(videos[0]).toHaveAttribute("poster", POSTER)
    expect(screen.queryAllByRole("img")).toHaveLength(0)
    expect(screen.queryByText(/^Media \(/)).not.toBeInTheDocument()
  })

  it("an RSS post keeps its editorial photo as the hero — its one video stays in the gallery", () => {
    const OG = "https://news.example/og.jpg"
    const CLIP = "https://news.example/clip.mp4"
    render(<MaterialDetailPage material={material({ thumbnailUrl: OG, mediaUrls: [CLIP] })} />)

    expect(imageSources()).toEqual([OG])
    expect(screen.getByText("Media (1)")).toBeInTheDocument()
    const video = document.querySelector("video")
    expect(video).toHaveAttribute("src", CLIP)
    expect(video).not.toHaveAttribute("poster")
  })

  it("a video post without a poster still plays in the hero", () => {
    const VIDEO = "https://cdn.example/telegram/ch/6.mp4"
    render(<MaterialDetailPage material={material({ thumbnailUrl: null, mediaUrls: [VIDEO] })} />)

    expect(document.querySelectorAll("video")).toHaveLength(1)
    expect(screen.queryByText(/^Media \(/)).not.toBeInTheDocument()
  })

  it("RAD-400 AC-13: a Telegram album with no thumbnail shows its photo and a poster-less video", () => {
    const PHOTO = "https://cdn.example/telegram/ch/7.jpg"
    const CLIP = "https://cdn.example/telegram/ch/7.mp4"
    render(
      <MaterialDetailPage
        material={material({
          thumbnailUrl: null,
          mediaUrls: [PHOTO, CLIP],
          feed: { id: "feed-tg", name: "e/acc", type: "TELEGRAM" as const },
        })}
      />
    )

    // The photo is an album frame, not the video's poster: it stays a picture.
    expect(imageSources()).toEqual([PHOTO])
    const videos = document.querySelectorAll("video")
    expect(videos).toHaveLength(1)
    expect(videos[0]).toHaveAttribute("src", CLIP)
    expect(videos[0].getAttribute("poster")).not.toBe(PHOTO)
  })

  it("RAD-400 review: a video-only tweet (the .mp4 stored as thumbnail) still plays its video", () => {
    const VIDEO = "https://video.twimg.example/ext_tw_video/1/pu/vid/720x1280/v.mp4"
    render(
      <MaterialDetailPage
        material={material({
          thumbnailUrl: VIDEO,
          mediaUrls: [VIDEO],
          feed: { id: "feed-x", name: "X", type: "TWITTER" as const },
        })}
      />
    )

    const videos = document.querySelectorAll("video")
    expect(videos).toHaveLength(1)
    expect(videos[0]).toHaveAttribute("src", VIDEO)
  })

  it("still embeds a YouTube link and shows the Telegram placeholder", () => {
    render(
      <MaterialDetailPage
        material={material({
          thumbnailUrl: null,
          mediaUrls: ["https://youtu.be/abc", "tg://photo/1"],
        })}
      />
    )

    expect(screen.getByText("Media (2)")).toBeInTheDocument()
    expect(screen.getByTitle("Video 1")).toHaveAttribute("src", "https://youtu.be/abc")
    expect(screen.getByText("Telegram media")).toBeInTheDocument()
  })
})
