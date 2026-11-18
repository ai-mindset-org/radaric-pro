/**
 * The Parallel (EVENT_TRIGGER) parser must not write article links into the
 * media column.
 *
 * Reported from production 2026-09-12: cards showed the gallery chip `1/2` and
 * no swipe ever revealed a second image. `mediaUrls` held the event's
 * `source_urls` — the pages the event was found on — and every surface in the
 * app renders that column as images. Asserted against the source because the
 * write sits inside `parseInterestFeed`'s `createMany` payload, behind a
 * Parallel API call and an LLM evaluation; the property worth locking is that
 * neither write site can pass an unfiltered list again.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isRenderableImageUrl } from "@/lib/media-urls"

const SOURCE = readFileSync(join(process.cwd(), "lib/parsers/interest.ts"), "utf-8")

describe("interest parser — mediaUrls", () => {
  it("filters source URLs through the image predicate at every write site", () => {
    const writes = SOURCE.match(/mediaUrls:.*/g) ?? []
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      expect(write).toContain("filter(isRenderableImageUrl)")
    }
  })

  it("never writes the raw source_urls list", () => {
    expect(SOURCE).not.toMatch(/mediaUrls:\s*item\.sourceUrls\s*,/)
  })

  it("the predicate it filters with rejects the shape Parallel actually returns", () => {
    // Sampled from the dev DB's EVENT_TRIGGER rows.
    expect(isRenderableImageUrl("https://www.pentagram.com/work/london-design-biennale-2025")).toBe(
      false
    )
    expect(isRenderableImageUrl("https://mashable.com/article/sora-videos-social-media")).toBe(false)
    expect(isRenderableImageUrl("https://cdn.site/og/seedance.jpg")).toBe(true)
  })
})
