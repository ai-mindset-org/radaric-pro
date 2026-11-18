import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * RAD-230 — `scrollbar-gutter: stable` on containers whose content grows and
 * shrinks, so a scrollbar's appearance never shifts the layout sideways.
 * Two flat utilities live next to `.scrollbar-none` in app/globals.css:
 * `.scrollbar-stable` (single edge — side-docked panes) and
 * `.scrollbar-stable-both` (`stable both-edges` — horizontally-centered
 * content, where an edge-only gutter would itself unbalance the layout).
 *
 * This guards both the utility definitions and every container the RAD-230
 * audit applied them to — a silent regression here shows nothing in a
 * screenshot until content grows past the fold, which is exactly the failure
 * mode the ticket exists to close.
 */
const root = resolve(__dirname, "..")
const css = readFileSync(join(root, "app/globals.css"), "utf-8")

describe("scrollbar-gutter utilities (app/globals.css)", () => {
  it("defines .scrollbar-stable as scrollbar-gutter: stable", () => {
    expect(css).toMatch(/\.scrollbar-stable\s*\{\s*scrollbar-gutter:\s*stable;\s*\}/)
  })

  it("defines .scrollbar-stable-both as scrollbar-gutter: stable both-edges", () => {
    expect(css).toMatch(/\.scrollbar-stable-both\s*\{\s*scrollbar-gutter:\s*stable both-edges;\s*\}/)
  })
})

const STABLE = "scrollbar-stable"
const STABLE_BOTH = "scrollbar-stable-both"

/**
 * [file, expected utility class, minimum occurrence count] — one row per
 * container from the RAD-230 audit (file:line in the PR description).
 * `both-edges` goes only on content centred by auto margins (the centred
 * form columns, the peek reading column under its header); plain `stable`
 * goes everywhere content is left-aligned with siblings outside the scroller
 * — dialog bodies under their header and footer, the dashboard shell's main
 * pane, the processing log, the folder submenu. A both-edges gutter there
 * would indent the body against its own title.
 */
const containers: [string, string, number][] = [
  ["components/layout/dashboard-shell.tsx", STABLE, 1],
  ["app/(dashboard)/feeds/[id]/edit/page.tsx", STABLE_BOTH, 1],
  ["components/feeds/new-feed-content.tsx", STABLE_BOTH, 2],
  ["components/feeds/bulk-add-feeds-dialog.tsx", STABLE, 1],
  ["components/materials/processing-card.tsx", STABLE, 2],
  ["components/peek/peek-panel.tsx", STABLE_BOTH, 1],
  ["components/peek/peek-sheet.tsx", STABLE_BOTH, 1],
  ["components/saved/discover-sources-dialog.tsx", STABLE, 1],
  ["components/layout/sidebar-source-row.tsx", STABLE, 1],
]

describe("scrollbar-gutter applied to the RAD-230 audited containers", () => {
  it.each(containers)("%s carries %s at least %i time(s)", (file, className, minCount) => {
    const source = readFileSync(join(root, file), "utf-8")
    // A trailing negative lookahead so counting the plain `scrollbar-stable`
    // variant doesn't also count `scrollbar-stable-both` occurrences — `\b`
    // alone matches at the `e`→`-` transition either way.
    const pattern =
      className === STABLE ? `\\b${STABLE}\\b(?!-both)` : `\\b${STABLE_BOTH}\\b`
    const matches = source.match(new RegExp(pattern, "g")) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(minCount)
  })
})
