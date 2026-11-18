/**
 * @vitest-environment jsdom
 */

/**
 * RAD-400 — the story page's media grid shows every member post's media, not
 * only the Telegram inbox items'. `StoryArticle` renders `storyDetailMedia`:
 * a "Media (N)" label, up to 6 visual tiles with a "Show K more" button that
 * mounts the rest, and the files (audio, documents, too-large placeholders)
 * below the grid, uncapped.
 *
 * Material rows below the body keep their own decorative thumbnails (`alt=""`,
 * role presentation), so grid tiles are queried by their accessible name
 * "<post title> — image k".
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

import { StoryArticle } from "@/components/stories/story-article"

afterEach(cleanup)

const img = (name: string) => `https://cdn.example.com/${name}.jpg`

function material(
  id: string,
  title: string,
  thumbnailUrl: string | null,
  mediaUrls: string[],
  type: string = "RSS"
) {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    content: "Plain body copy.",
    publishedAt: new Date("2026-10-01T10:00:00Z"),
    thumbnailUrl,
    mediaUrls,
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 80,
    aiReasoning: null,
    userStatus: "NEW",
    createdAt: "2026-10-01T10:00:00Z",
    feed: { id: `feed-${id}`, name: `Feed ${id}`, type },
    feedbacks: [],
  }
}

function story(materials: ReturnType<typeof material>[]) {
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
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    materials,
    inboxItems: [],
  }
}

/** Grid image tiles, by accessible name; row thumbnails (alt="") are excluded. */
function tiles() {
  return screen.queryAllByRole("img", { name: / — image \d+$/ })
}

function eightImageStory(extraMedia: string[] = []) {
  const urls = Array.from({ length: 8 }, (_, i) => img(`m${i + 1}`))
  return story([material("mat-1", "Gallery post", urls[0], [...urls, ...extraMedia])])
}

describe("StoryArticle — member post media (RAD-400)", () => {
  it("AC-8: a story whose only media come from materials renders 'Media (N)' and titled image tiles", () => {
    render(
      <StoryArticle
        story={story([
          material("mat-a", "Post A", img("a1"), [img("a1"), img("a2")]),
          material("mat-b", "Post B", img("b1"), []),
        ])}
        actions={[]}
      />
    )

    expect(screen.getByText("Media (3)")).toBeInTheDocument()
    expect(tiles().map((t) => [t.getAttribute("alt"), t.getAttribute("src")])).toEqual([
      ["Post A — image 1", img("a1")],
      ["Post B — image 1", img("b1")],
      ["Post A — image 2", img("a2")],
    ])
  })

  // Review change: the button names what it adds ("Show 2 more"), not the
  // visual total ("Show all 8"), which disagreed with "Media (N)" whenever the
  // story also carried files.
  it("AC-9: more than 6 visual entries show 6 tiles and 'Show 2 more'; clicking mounts all 8 and removes the button", () => {
    render(<StoryArticle story={eightImageStory()} actions={[]} />)

    expect(tiles().map((t) => t.getAttribute("src"))).toEqual([
      img("m1"),
      img("m2"),
      img("m3"),
      img("m4"),
      img("m5"),
      img("m6"),
    ])
    const button = screen.getByRole("button", { name: /show 2 more/i })

    fireEvent.click(button)

    expect(tiles()).toHaveLength(8)
    expect(tiles()[7].getAttribute("src")).toBe(img("m8"))
    expect(tiles()[7].getAttribute("alt")).toBe("Gallery post — image 8")
    expect(screen.queryByRole("button", { name: /show \d+ more/i })).toBeNull()
  })

  it("AC-9: six or fewer visual entries render all of them with no 'Show more' button", () => {
    const urls = Array.from({ length: 6 }, (_, i) => img(`s${i + 1}`))
    render(
      <StoryArticle story={story([material("mat-1", "Six", urls[0], urls)])} actions={[]} />
    )

    expect(screen.getByText("Media (6)")).toBeInTheDocument()
    expect(tiles()).toHaveLength(6)
    expect(screen.queryByRole("button", { name: /show \d+ more/i })).toBeNull()
  })

  it("AC-10: a Telegram video renders a <video> carrying the post's poster, and the poster is no tile", () => {
    const POSTER = "https://cdn.example.com/telegram/ch/5_thumb.jpg"
    const CLIP = "https://cdn.example.com/telegram/ch/5.mp4"
    render(
      <StoryArticle
        story={story([material("mat-tg", "Reel", POSTER, [CLIP], "TELEGRAM")])}
        actions={[]}
      />
    )

    expect(screen.getByText("Media (1)")).toBeInTheDocument()
    const videos = document.querySelectorAll("video")
    expect(videos).toHaveLength(1)
    expect(videos[0]).toHaveAttribute("src", CLIP)
    expect(videos[0]).toHaveAttribute("poster", POSTER)
    expect(tiles()).toHaveLength(0)
  })

  it("AC-11: files render below the visual grid, all of them, regardless of the cap", () => {
    const VOICE = "https://x.example/voice.ogg"
    const PDF = "https://x.example/report.pdf"
    render(
      <StoryArticle
        story={eightImageStory([VOICE, PDF, "tg://too-large/eaccrussia/5"])}
        actions={[]}
      />
    )

    expect(screen.getByText("Media (11)")).toBeInTheDocument()
    // Cap applies to visual only: 6 tiles, and the button counts the hidden
    // visual entries — the files are already on screen.
    expect(tiles()).toHaveLength(6)
    expect(screen.getByRole("button", { name: /show 2 more/i })).toBeInTheDocument()

    const audio = document.querySelector("audio")
    expect(audio).toHaveAttribute("src", VOICE)
    const pdf = screen.getByRole("link", { name: /open\s*pdf/i })
    expect(pdf).toHaveAttribute("href", PDF)
    expect(screen.getByText(/not mirrored/i)).toBeInTheDocument()

    const lastTile = tiles()[5]
    expect(lastTile.compareDocumentPosition(audio!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(lastTile.compareDocumentPosition(pdf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("EC-2: no media → neither the label nor any tile; one member image → the label appears", () => {
    const { unmount } = render(
      <StoryArticle story={story([material("mat-1", "Text only", null, [])])} actions={[]} />
    )
    expect(screen.queryByText(/^Media \(/)).toBeNull()
    expect(tiles()).toHaveLength(0)
    expect(document.querySelector("video")).toBeNull()
    unmount()

    // Near-miss positive control: the same story with one image is not swallowed.
    render(
      <StoryArticle story={story([material("mat-1", "Text only", img("one"), [])])} actions={[]} />
    )
    expect(screen.getByText("Media (1)")).toBeInTheDocument()
    expect(tiles().map((t) => t.getAttribute("src"))).toEqual([img("one")])
  })

  it("review: two channels' tg://photo/12 render as two placeholders without a duplicate-key warning", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      render(
        <StoryArticle
          story={story([
            material("mat-a", "Channel A", null, ["tg://photo/12"], "TELEGRAM"),
            material("mat-b", "Channel B", null, ["tg://photo/12"], "TELEGRAM"),
          ])}
          actions={[]}
        />
      )

      expect(screen.getByText("Media (2)")).toBeInTheDocument()
      const duplicateKey = consoleError.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && /same key/i.test(a))
      )
      expect(duplicateKey).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })

  it("review: failed images give their slot back — the 7th and 8th move up and the button count drops", () => {
    render(<StoryArticle story={eightImageStory()} actions={[]} />)
    expect(screen.getByRole("button", { name: /show 2 more/i })).toBeInTheDocument()

    fireEvent.error(screen.getByRole("img", { name: "Gallery post — image 2" }))
    fireEvent.error(screen.getByRole("img", { name: "Gallery post — image 5" }))

    expect(tiles().map((t) => t.getAttribute("src"))).toEqual([
      img("m1"),
      img("m3"),
      img("m4"),
      img("m6"),
      img("m7"),
      img("m8"),
    ])
    // Nothing is left behind the cap, so there is nothing to show more of.
    expect(screen.queryByRole("button", { name: /show \d+ more/i })).toBeNull()
    // The label counts the story's media, failed or not — as the post page does.
    expect(screen.getByText("Media (8)")).toBeInTheDocument()
  })

  it("review: one failed image among nine leaves 'Show 2 more'", () => {
    const urls = Array.from({ length: 9 }, (_, i) => img(`n${i + 1}`))
    render(<StoryArticle story={story([material("mat-1", "Nine", urls[0], urls)])} actions={[]} />)
    expect(screen.getByRole("button", { name: /show 3 more/i })).toBeInTheDocument()

    fireEvent.error(screen.getByRole("img", { name: "Nine — image 1" }))

    expect(tiles()).toHaveLength(6)
    expect(tiles()[5].getAttribute("src")).toBe(img("n7"))
    expect(screen.getByRole("button", { name: /show 2 more/i })).toBeInTheDocument()
  })

  it("inbox item: an extensionless thumbnail renders as image 'Media 1' and its .mp4 as a player", () => {
    const THUMB = "https://x/thumb"
    const CLIP = "https://x/clip.mp4"
    const s = story([])
    s.inboxItems = [
      {
        id: "inbox-1",
        externalId: "ext-1",
        messageId: 7,
        rawText: null,
        extractedUrl: null,
        extractedTitle: "Inbox post",
        mediaUrls: [CLIP],
        thumbnailUrl: THUMB,
        sourceChannel: "channel",
        status: "PROCESSED",
        createdAt: "2026-10-01T10:00:00Z",
      },
    ] as never
    render(<StoryArticle story={s} actions={[]} />)

    expect(screen.getByText("Media (2)")).toBeInTheDocument()
    const images = screen.getAllByRole("img", { name: /^Media \d+$/ })
    expect(images.map((i) => [i.getAttribute("alt"), i.getAttribute("src")])).toEqual([
      ["Media 1", THUMB],
    ])
    const videos = document.querySelectorAll("video")
    expect(videos).toHaveLength(1)
    expect(videos[0]).toHaveAttribute("src", CLIP)
  })

  it("ERR-1: an image tile that fails to load is hidden; its siblings stay", () => {
    render(
      <StoryArticle
        story={story([material("mat-a", "Post A", img("a1"), [img("a1"), img("a2")])])}
        actions={[]}
      />
    )

    const broken = screen.getByRole("img", { name: "Post A — image 1" })
    fireEvent.error(broken)

    expect(screen.queryByRole("img", { name: "Post A — image 1" })).toBeNull()
    expect(screen.getByRole("img", { name: "Post A — image 2" })).toHaveAttribute("src", img("a2"))
  })
})
