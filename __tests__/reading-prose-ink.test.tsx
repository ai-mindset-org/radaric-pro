/**
 * @vitest-environment jsdom
 */

/**
 * The post and story reading bodies read at the app ink, not at Tailwind
 * Typography's gray-700 `--tw-prose-body` default (RAD-361).
 *
 * The trap this pins: the reading surfaces also wear `dark:prose-invert`
 * (class-scoped to `.dark` since RAD-362), and that rule re-points
 * `--tw-prose-body` at the invert variable — so `prose-ink` must point the
 * invert variable at the same ink, and nothing may write it afterwards.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import "@testing-library/jest-dom/vitest"
import { render } from "@testing-library/react"

import { MaterialArticle } from "@/components/materials/material-article"
import { StoryArticle, type StoryArticleStory } from "@/components/stories/story-article"

const root = resolve(__dirname, "..")
const cssPath = join(root, "app/globals.css")

async function emit(...candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(cssPath, "utf-8"), {
    base: dirname(cssPath),
    onDependency: () => {},
  })
  return compiler.build(candidates)
}

/** Every value written to `variable` in the emitted CSS, in source order. */
function writes(css: string, variable: string): string[] {
  return [...css.matchAll(new RegExp(`${variable}:\\s*([^;}]+)`, "g"))].map(m => m[1].trim())
}

describe("prose-ink — the reading body carries the ink", () => {
  it("control: without the utility the body is the plugin's gray, never the ink", async () => {
    // Positive control for the assertions below: the plugin default must exist
    // and must NOT already be the ink, or they could pass vacuously. The value
    // itself is not pinned — only that a real colour is emitted.
    const fallback = writes(await emit("prose"), "--tw-prose-body").at(-1)
    expect(fallback).toMatch(/^(#|rgb|oklch)/)
    expect(fallback).not.toBe("var(--foreground)")
  })

  it("emits both the body and the invert-body variables as --foreground", async () => {
    const css = await emit("prose-ink")
    expect(writes(css, "--tw-prose-body")).toContain("var(--foreground)")
    expect(writes(css, "--tw-prose-invert-body")).toContain("var(--foreground)")
  })

  it("keeps the chain resolving to the ink when dark:prose-invert wins", async () => {
    const css = await emit("prose", "prose-ink", "dark:prose-invert")
    // The invert variable is prose-ink's to write last — the invert path must
    // land on the same ink. If it resolves anywhere else, a media-dark OS
    // hands a light-themed app its old gray body back.
    expect(writes(css, "--tw-prose-invert-body").at(-1)).toBe("var(--foreground)")
    // The body variable is either prose-ink's own ink, or the invert chain
    // above — any other last writer is a regression.
    expect(writes(css, "--tw-prose-body").at(-1)).toMatch(
      /^var\(--(tw-prose-invert-body|foreground)\)$/
    )
  })
})

describe("the reading surfaces apply prose-ink", () => {
  it("a post's body carries the utility", () => {
    const { container } = render(
      <MaterialArticle
        actions={[]}
        material={{
          id: "mat-1",
          title: "A hand-written headline",
          url: "https://example.com/post",
          content: "Body text that should read at the ink.",
          contentEntities: null,
          publishedAt: new Date("2026-09-26T12:00:00Z"),
          thumbnailUrl: null,
          mediaUrls: [],
          aiEvaluation: "APPROVED",
          aiConfidence: 90,
          aiReasoning: null,
          userStatus: "NEW",
          feed: { id: "feed-1", name: "Example", type: "RSS" },
          feedbacks: [],
        }}
      />
    )

    const prose = container.querySelector(".prose")
    expect(prose).not.toBeNull()
    expect(prose).toHaveClass("prose-ink")
    expect(prose?.textContent).toContain("Body text that should read at the ink.")
  })

  it("a story's body carries the utility", () => {
    const story: StoryArticleStory = {
      id: "story-1",
      title: "A story headline",
      languageFlag: null,
      summary: "The deck.",
      body: "Story body that should read at the ink.",
      keyPoints: [],
      sourceUrls: [],
      rubrics: [],
      archiveLinks: null,
      notionPageId: null,
      notionUrl: null,
      status: "NEW",
      version: 1,
      createdAt: "2026-09-26T12:00:00Z",
      updatedAt: "2026-09-26T12:00:00Z",
      materials: [],
      inboxItems: [],
    }

    const { container } = render(<StoryArticle story={story} actions={[]} onOpenMaterial={() => {}} />)

    const prose = container.querySelector(".prose")
    expect(prose).not.toBeNull()
    expect(prose).toHaveClass("prose-ink")
    expect(prose?.textContent).toContain("Story body that should read at the ink.")
  })
})
