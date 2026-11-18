/**
 * @vitest-environment jsdom
 */

/**
 * Links wear the IDS treatment (RAD-366): always underlined, the rule a 20%
 * tint of the link's own colour, hover deepening the colour instantly with the
 * rule following, and focus as an outline. One custom utility, `link`,
 * consumed bare on a standalone anchor and as `[&_a]:link` on a prose
 * container.
 *
 * Two traps this pins.
 *
 * 1. THE CALL-SITE CLEANUP IS CORRECTNESS, NOT HYGIENE. `link` is a custom
 *    utility, so in the utilities layer it sits at the same (0,1,0) as the
 *    core utilities — and the core colour/decoration utilities sort AFTER it
 *    (measured in this sheet: `.link` before `.text-primary-emphasis`,
 *    `.underline-offset-4`, `.transition-colors`), so a leftover class on a
 *    converted element silently wins and the port ships looking done. The
 *    sweep below therefore asserts the old classes are GONE.
 *
 * 2. THE PROSE ROUTE IS SPECIFICITY, NOT LAYER. Tailwind Typography emits
 *    into the same utilities layer, so there is no layer advantage:
 *    `[&_a]:link` compiles to a descendant selector at (0,1,1) and must
 *    outrank `.prose :where(a)` at (0,1,0). Pinned by selector shape and
 *    emission order — asserting "our layer wins" would pin the wrong
 *    mechanism.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import "@testing-library/jest-dom/vitest"
import { render } from "@testing-library/react"

import { MaterialArticle } from "@/components/materials/material-article"
import { StoryArticle, type StoryArticleStory } from "@/components/stories/story-article"
import { convertTelegramEntitiesToReact } from "@/lib/telegram-entities-to-react"

const root = resolve(__dirname, "..")
const cssPath = join(root, "app/globals.css")

async function emit(...candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(cssPath, "utf-8"), {
    base: dirname(cssPath),
    onDependency: () => {},
  })
  return compiler.build(candidates)
}

const flat = (s: string) => s.replace(/\s+/g, " ")

/** Body of the first rule whose selector is exactly `selector`, nesting included. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} must be emitted`).toBeGreaterThan(-1)
  const open = css.indexOf("{", at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++
    if (css[i] === "}") depth--
    if (depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`unclosed rule ${selector}`)
}

/** Every value written to `variable` in the emitted CSS, in source order. */
function writes(css: string, variable: string): string[] {
  return [...css.matchAll(new RegExp(`${variable}:\\s*([^;}]+)`, "g"))].map((m) => m[1].trim())
}

describe("the link utility — the IDS contract", () => {
  it("control: prose already styles its own anchors, and not with this treatment", async () => {
    // Positive control: the Typography plugin's link rule must exist and must
    // NOT already be the treatment, or the container assertions could pass
    // vacuously.
    const css = await emit("prose")
    expect(css).toContain("--tw-prose-links")
    expect(css).not.toContain("color: var(--link)")
  })

  it("emits the full contract on .link", async () => {
    const body = flat(ruleBody(await emit("link"), ".link"))
    expect(body).toContain("color: var(--link);")
    expect(body).toContain("text-decoration-line: underline;")
    expect(body).toContain("text-decoration-thickness: 1px;")
    expect(body).toContain("text-underline-offset: 0.2em;")
    expect(body).toContain("text-decoration-skip-ink: none;")
    // The tint rides currentColor, with Lightning CSS's plain-colour fallback.
    expect(body).toContain("text-decoration-color: currentColor;")
    expect(body).toContain("@supports (color: color-mix(in lab, red, red))")
    expect(body).toContain("text-decoration-color: color-mix(in oklab, currentColor 20%, transparent);")
    expect(body).toContain(
      "transition: color var(--dur-fast) var(--ease-snap), text-decoration-color var(--dur-fast) var(--ease-snap);"
    )
  })

  it("deepens on hover instantly, and only where hover exists", async () => {
    const body = flat(ruleBody(await emit("link"), ".link"))
    // A raw &:hover is not media-gated the way Tailwind's hover: variant is —
    // without the wrapper a tap on touch fires the state and can stick.
    expect(body).toContain("@media (hover: hover) { &:hover { color: var(--link-hover); transition-duration: 0s; } }")
  })

  it("brings its own focus outline, below the Button's outline-none in specificity", async () => {
    const body = flat(ruleBody(await emit("link"), ".link"))
    // :where keeps this at (0,1,0) so a Button variant="link" keeps its inset
    // ring (its focus-visible:outline-none is (0,2,0)) — and keeps it by
    // specificity rather than by emission order.
    expect(body).toContain("&:where(:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }")
  })

  it("resolves the pair through the theme with one declaration", async () => {
    // One alias in :root, deliberately NOT duplicated in .dark: a custom
    // property substitutes var() on the element it is declared on, so the
    // alias follows --primary through the class swap by itself (verified in
    // Chromium — a .dark copy changes nothing). The count assertion is the
    // point: a set-of-values check cannot tell a live declaration from dead
    // weight someone later trusts.
    const css = await emit("link")
    expect(writes(css, "--link")).toEqual(["var(--primary)"])
    expect(writes(css, "--link-hover")).toEqual(["var(--primary-active)"])
  })

  it("link-on-tint remaps the pair, and its dark block moves only the hover", async () => {
    // The tinted-zone fix itself (RAD-387). Without this pin, deleting the
    // nested .dark block keeps every suite green while dark-mode links on a
    // tint stop deepening. The counts are the second point: the dark block
    // must not rewrite --link — the rest stays --primary-emphasis in both
    // themes, only the hover step flips so it keeps brightening.
    const css = await emit("link", "link-on-tint")
    expect(writes(css, "--link")).toEqual(["var(--primary-emphasis)", "var(--primary)"])
    expect(writes(css, "--link-hover")).toEqual([
      "var(--primary-active)",
      "var(--primary-subtle-foreground)",
      "var(--primary-active)",
    ])
  })

  it("reaches inside a prose container by specificity, at (0,1,1)", async () => {
    const css = await emit("prose", "[&_a]:link")
    const proseAt = css.indexOf(".prose {")
    const containerAt = css.indexOf(".\\[\\&_a\\]\\:link {")
    expect(proseAt).toBeGreaterThan(-1)
    expect(containerAt).toBeGreaterThan(proseAt)
    // The container rule styles an anchor DESCENDANT — that extra element in
    // the selector is what beats `.prose :where(a)` whatever the sort does.
    expect(flat(ruleBody(css, ".\\[\\&_a\\]\\:link")).trim().startsWith("& a {")).toBe(true)
  })

  it("sorts after the core utilities it replaces", async () => {
    // Canary for the sweep below: this is WHY leftovers must be deleted. If a
    // future Tailwind re-sorts these, revisit the sweep deliberately — the
    // cleanup stays correct either way.
    const css = await emit("link", "text-primary-emphasis", "underline-offset-4", "transition-colors")
    const linkAt = css.indexOf(".link {")
    for (const leftover of [".text-primary-emphasis {", ".underline-offset-4 {", ".transition-colors {"]) {
      expect(css.indexOf(leftover), `${leftover} sorts after .link`).toBeGreaterThan(linkAt)
    }
    // The one order the Button link variant depends on: its own property list
    // must sort after the Button base's, or the rule colour snaps while the
    // text fades (both are (0,1,0); later wins).
    const buttonCss = await emit(
      "transition-[background-color,box-shadow,transform,color]",
      "transition-[color,text-decoration-color]",
      "duration-150",
      "duration-[var(--dur-fast)]",
      "ease-[var(--ease-out-quart)]",
      "ease-[var(--ease-snap)]"
    )
    expect(buttonCss.indexOf(".transition-\\[color\\,text-decoration-color\\]")).toBeGreaterThan(
      buttonCss.indexOf(".transition-\\[background-color")
    )
    // Same property, same specificity — the variant's own tokens must sort
    // after the base's or the button's rhythm wins and a --dur-fast retune
    // reaches no link (RAD-387).
    expect(buttonCss.indexOf(".duration-\\[var\\(--dur-fast\\)\\]")).toBeGreaterThan(
      buttonCss.indexOf(".duration-150")
    )
    expect(buttonCss.indexOf(".ease-\\[var\\(--ease-snap\\)\\]")).toBeGreaterThan(
      buttonCss.indexOf(".ease-\\[var\\(--ease-out-quart\\)\\]")
    )
  })
})

describe("the link renderers", () => {
  const entities = [
    { className: "MessageEntityTextUrl", offset: 0, length: 5, url: "https://example.com" },
  ]

  it("a full Telegram link joins the treatment", () => {
    const { container } = render(
      <div>{convertTelegramEntitiesToReact("hello world", entities, "full")}</div>
    )
    const a = container.querySelector("a")
    expect(a).toHaveClass("link")
    expect(a).not.toHaveClass("text-primary-emphasis")
  })

  it("a compact Telegram link keeps the quiet hover — card excerpts are not prose", () => {
    const { container } = render(
      <div>{convertTelegramEntitiesToReact("hello world", entities, "compact")}</div>
    )
    const a = container.querySelector("a")
    expect(a).toHaveClass("text-primary-emphasis")
    expect(a).not.toHaveClass("link")
  })

  it("the headline wrapper carries the treatment for both of its paths", () => {
    // Source shape: the wrapper class also fixes the HTML path, whose anchors
    // preflight leaves colourless and unruled. Scoped to a[href]: a sanitized
    // href-less anchor is dead text and must not look clickable (RAD-367).
    const source = readFileSync(join(root, "components/materials/material-title.tsx"), "utf-8")
    expect(source).toContain('"[&_a[href]]:[font-weight:inherit] [&_a[href]]:link"')
  })

  it("the dialog and the living answer route their anchors too (source shape)", () => {
    for (const file of [
      "components/materials/material-detail-dialog.tsx",
      "components/saved/living-answer.tsx",
    ]) {
      const source = readFileSync(join(root, file), "utf-8")
      expect(source, file).toContain("[&_a]:link")
      expect(source, file).not.toMatch(/prose-a:/)
    }
  })
})

describe("the reading surfaces route their anchors through the utility", () => {
  const material = {
    id: "mat-1",
    title: "A hand-written headline",
    url: "https://example.com/post",
    content: "Body text with a link.",
    contentEntities: null,
    publishedAt: new Date("2026-09-26T12:00:00Z"),
    thumbnailUrl: null,
    mediaUrls: [],
    aiEvaluation: "APPROVED" as const,
    aiConfidence: 90,
    aiReasoning: null,
    userStatus: "NEW" as const,
    feed: { id: "feed-1", name: "Example", type: "RSS" },
    feedbacks: [],
  }

  it("a post's prose container routes anchors and drops the old overrides", () => {
    const { container } = render(<MaterialArticle actions={[]} material={material} />)
    const prose = container.querySelector(".prose")
    expect(prose).not.toBeNull()
    expect(prose).toHaveClass("[&_a]:link")
    expect(prose?.className).not.toMatch(/prose-a:/)
  })

  it("a story's prose container routes anchors and drops the old overrides", () => {
    const story: StoryArticleStory = {
      id: "story-1",
      title: "A story headline",
      languageFlag: null,
      summary: "The deck.",
      body: "Story body with a link.",
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
    expect(prose).toHaveClass("[&_a]:link")
    expect(prose?.className).not.toMatch(/prose-a:/)
  })
})

describe("no converted element carries a leftover core utility", () => {
  // The classes the treatment replaces. A `link` sharing an element with any
  // of these is a half-done migration: the core utility sorts after the
  // custom one and silently wins (the canary above is why).
  const banned = [
    /(?:^|\s)text-primary(-emphasis)?(?=\s|$)/,
    /(?:^|\s)underline-offset-\d/,
    /(?:^|\s)hover:underline(?=\s|$)/,
    /(?:^|\s)transition-colors(?=\s|$)/,
    /(?:^|\s)underline(?=\s|$)/,
    // The container form must not smuggle back the Typography overrides the
    // port removed — a leftover `prose-a:no-underline` loses to [&_a]:link
    // anyway, but its presence means the migration was half-done.
    /(?:^|\s|:)prose-a:/,
  ]
  const carriesLink = (text: string) => /(?:^|\s)link(?=\s|$)|\[&_a\]:link/.test(text)

  /**
   * Double-quoted and template literals only. Single quotes are NOT scanned:
   * an apostrophe in prose ("Telegram's") pairs with the next one across
   * paragraphs, and the span it swallows matches everything — measured, it
   * caught a whole module comment. No class list in this repo uses single
   * quotes today.
   */
  function literalsIn(text: string): string[] {
    return [...text.matchAll(/"([^"]*)"|`([^`]*)`/g)].map((m) =>
      (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ")
    )
  }

  /** Index of the delimiter closing the one at `start`; quoted strings are opaque. */
  function balancedEnd(text: string, start: number, open: string, close: string): number {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"' || ch === "'" || ch === "`") {
        i = stringEnd(text, i)
        continue
      }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return i
      }
    }
    return text.length
  }

  /** Index of the quote closing the one at `start` (escape-aware). */
  function stringEnd(text: string, start: number): number {
    const quote = text[start]
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "\\") i++
      else if (text[i] === quote) return i
    }
    return text.length
  }

  /**
   * Additive class-list groups between `from` and `to`: literals joined per run
   * of the expression, with {…} config objects skipped whole. A ternary's two
   * branches are alternatives on one element, never co-applied — so `?` and
   * `:` (outside strings) start a new group; without that, the deliberate
   * full/compact pair in lib/telegram-entities-to-react.tsx would read as a
   * leftover. Conditional cross-products (`cond ? "link" : …`, "banned" added
   * elsewhere in the same call) are the guard's known blind spot.
   */
  function classListGroups(text: string, from: number, to: number): string[] {
    const groups: string[] = []
    let current: string[] = []
    const flush = () => {
      if (current.length) groups.push(current.join(" "))
      current = []
    }
    for (let i = from; i < to; i++) {
      const ch = text[i]
      if (ch === "'") {
        i = stringEnd(text, i)
      } else if (ch === "{") {
        i = balancedEnd(text, i, "{", "}")
      } else if (ch === '"' || ch === "`") {
        const end = stringEnd(text, i)
        current.push(text.slice(i + 1, end).replace(/\$\{[^}]*\}/g, " "))
        i = end
      } else if (ch === "?" || ch === ":") {
        flush()
      }
    }
    flush()
    return groups
  }

  /**
   * One class list per scanned site — the fix for the literal-scoped gap:
   * `cn("link", "text-primary-emphasis …")` passed because no single literal
   * carried both, yet the leftover still won on the element. Sites are each
   * `className=` span (brace walk, quotes opaque) and each `cn(`/`cva(`
   * argument list; cva's config object is skipped whole — its variant values
   * are single literals and belong to the global literal scan, which
   * per-site scanning deliberately does not duplicate.
   */
  function siteClassLists(text: string): string[] {
    const sites: string[] = []
    for (const m of text.matchAll(/\bclassName\s*=\s*/g)) {
      const start = m.index! + m[0].length
      const ch = text[start]
      if (ch === "{") {
        const end = balancedEnd(text, start, "{", "}")
        sites.push(...classListGroups(text, start + 1, end))
      } else if (ch === '"' || ch === "`") {
        const end = stringEnd(text, start)
        sites.push(text.slice(start + 1, end).replace(/\$\{[^}]*\}/g, " "))
      }
    }
    for (const m of text.matchAll(/\b(?:cn|cva)\s*\(/g)) {
      const open = m.index! + m[0].length - 1
      const end = balancedEnd(text, open, "(", ")")
      sites.push(...classListGroups(text, open + 1, end))
    }
    return sites.map((site) => site.replace(/\s+/g, " ").trim()).filter((site) => site !== "")
  }

  /** Offender class lists in one source text: a `link` sharing text with a class it replaces. */
  function sweepSource(text: string): string[] {
    const offenders = new Set<string>()
    for (const literal of literalsIn(text)) {
      if (!carriesLink(literal)) continue
      if (banned.some((rule) => rule.test(literal))) offenders.add(literal.trim())
    }
    for (const site of siteClassLists(text)) {
      if (!carriesLink(site)) continue
      if (banned.some((rule) => rule.test(site))) offenders.add(site)
    }
    return [...offenders]
  }

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...sourceFiles(path))
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
    }
    return out
  }

  it("catches a class list split across cn arguments — the original gap", () => {
    expect(sweepSource('const c = cn("link", "text-primary-emphasis hover:underline")')).toEqual([
      "link text-primary-emphasis hover:underline",
    ])
  })

  it("joins a className span split across literals", () => {
    expect(sweepSource('<a className={"link " + "transition-colors"} />')).toEqual([
      "link transition-colors",
    ])
  })

  it("a clean split stays clean", () => {
    expect(sweepSource('const c = cn("link", "py-2 font-medium")')).toEqual([])
  })

  it("a ternary's branches are alternatives, not one class list", () => {
    // The deliberate full/compact pair in lib/telegram-entities-to-react.tsx.
    expect(
      sweepSource(
        'className={variant === "full" ? "link font-medium" : "font-medium text-primary-emphasis hover:underline"}'
      )
    ).toEqual([])
  })

  it("keeps the lone-literal scan for cva variant values", () => {
    // The per-site walk treats the config object as opaque, so this class of
    // site must stay owned by the literal scan.
    expect(
      sweepSource('const b = cva("base", { variants: { variant: { link: "link underline" } } })')
    ).toEqual(["link underline"])
  })

  it("a class list cannot carry `link` together with the classes it replaces", () => {
    const offenders: string[] = []
    for (const file of [...sourceFiles(join(root, "components")), ...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "lib"))]) {
      for (const snippet of sweepSource(readFileSync(file, "utf-8"))) {
        offenders.push(`${file.replace(root + "/", "")}: ${snippet}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
