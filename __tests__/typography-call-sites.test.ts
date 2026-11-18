import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

/**
 * RAD-363 slice 8 — every call site is classified into a typography role.
 *
 * The role rules in `app/globals.css` bind a font to an element by selector
 * (`.type-heading`, `.type-tag`, `.type-counter`, `h1–h6`, `body`). What they
 * cannot do is decide WHICH element is a counter or an eyebrow: that is a
 * judgement per call site, and it silently regresses when a new site copies
 * an old pattern. These guards read the source and pin the judgements that
 * would otherwise drift:
 *
 * - arbitrary em tracking must scale by the current font's factor, or it stays
 *   tuned for Inter under every other face;
 * - `tabular-nums` survives only where the figures are a date or a time —
 *   a quantity carries `type-counter`, which implies tabular figures and also
 *   puts the number in the Counters font. The allowlist is the classification:
 *   a new `tabular-nums` fails here until someone decides what it is;
 * - sentences with numbers inside wrap the number, never the sentence;
 * - the morph primitives, the wordmark and the known eyebrows carry their role.
 */

const root = resolve(__dirname, "..")
const DESIGN_SYSTEM = join("app", "(dashboard)", "design-system") + sep

function tsxFiles(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(dir, f))
    .filter((f) => !f.startsWith(DESIGN_SYSTEM))
    .sort()
}

const FILES = [...tsxFiles("components"), ...tsxFiles("app")]
const read = (file: string) => readFileSync(join(root, file), "utf-8")
const posix = (file: string) => file.split(sep).join("/")

interface Hit {
  file: string
  line: number
  text: string
}

function hits(pattern: RegExp): Hit[] {
  const out: Hit[] = []
  for (const file of FILES) {
    read(file)
      .split("\n")
      .forEach((text, i) => {
        if (pattern.test(text)) out.push({ file: posix(file), line: i + 1, text: text.trim() })
      })
  }
  return out
}

const where = (h: Hit) => `${h.file}:${h.line}  ${h.text.slice(0, 140)}`

describe("scope of the scan", () => {
  it("reads the dashboard's components and pages, not the design-system specimen", () => {
    const names = FILES.map(posix)
    expect(names).toContain("components/layout/dashboard-shell.tsx")
    expect(names).toContain("app/page.tsx")
    expect(names.some((f) => f.includes("design-system/"))).toBe(false)
  })
})

describe("tracking literals scale with the font", () => {
  /**
   * A literal `tracking-[0.09em]` is tuned for Inter. The theme's named
   * tracking tokens already multiply by `--type-df` (negative, display) or
   * `--type-cf` (positive, caps); an arbitrary value must do the same by hand.
   */
  const FACTORED = /^calc\((-?[\d.]+)em\*var\(--type-(df|cf),1\)\)$/

  function offenders(): string[] {
    const out: string[] = []
    for (const file of FILES) {
      read(file)
        .split("\n")
        .forEach((text, i) => {
          const at = `${posix(file)}:${i + 1}`
          for (const m of text.matchAll(/(-?)tracking-\[([^\]]+)\]/g)) {
            const [whole, neg, value] = m
            if (!/em\b/.test(value)) continue
            const f = value.match(FACTORED)
            if (!f) {
              out.push(`${at}  ${whole}  (literal em tracking)`)
              continue
            }
            if (neg) out.push(`${at}  ${whole}  (negate inside the calc, not with a "-" prefix)`)
            const negative = Number(f[1]) < 0
            if (negative && f[2] !== "df") out.push(`${at}  ${whole}  (negative tracking scales by --type-df)`)
            if (!negative && f[2] !== "cf") out.push(`${at}  ${whole}  (positive tracking scales by --type-cf)`)
          }
          for (const m of text.matchAll(/\[letter-spacing:([^\]]+)\]/g)) {
            if (/em\b/.test(m[1]) && !/var\(--type-(df|cf)/.test(m[1])) out.push(`${at}  ${m[0]}`)
          }
          if (/letterSpacing\s*:/.test(text) && !/var\(--type-(df|cf)/.test(text)) {
            out.push(`${at}  inline letterSpacing`)
          }
        })
    }
    return out
  }

  it("leaves no arbitrary em tracking that ignores --type-df / --type-cf", () => {
    expect(offenders()).toEqual([])
  })
})

describe("tabular-nums is reserved for dates and times", () => {
  /**
   * Every surviving `tabular-nums`, with the reason it is not a counter. Each
   * `snippet` must appear on the line that carries the class. Keep this list
   * short: a quantity belongs in `type-counter`, not here.
   */
  const ALLOWED: { file: string; snippet: string; kind: "date-time"; reason: string }[] = [
    {
      file: "components/materials/processing-card.tsx",
      snippet: 'className="shrink-0 tabular-nums text-muted-foreground"',
      kind: "date-time",
      reason: "the full log's <time> column (toLocaleTimeString) — a clock time, stays in the text font",
    },
    {
      file: "components/saved/living-answer.tsx",
      snippet: "{format(updatedDate",
      kind: "date-time",
      reason: "the living answer's 'Updated d MMM yyyy, HH:mm' stamp — a date, stays in the text font",
    },
    {
      file: "components/admin/admin-dashboard.tsx",
      snippet: 'cn("tabular-nums", sub.state === "past_due"',
      kind: "date-time",
      reason:
        "the admin subscription summary line — 'Renews on / Access until / since' dates, stays in the text font",
    },
  ]

  const found = hits(/\btabular-nums\b/)

  it("every tabular-nums site is classified in the allowlist", () => {
    const unclassified = found.filter(
      (h) => !ALLOWED.some((a) => a.file === h.file && h.text.includes(a.snippet))
    )
    expect(unclassified.map(where)).toEqual([])
  })

  it("the allowlist has no stale entries", () => {
    const stale = ALLOWED.filter(
      (a) => !found.some((h) => h.file === a.file && h.text.includes(a.snippet))
    )
    expect(stale.map((a) => `${a.file}  ${a.snippet}`)).toEqual([])
  })
})

/**
 * A tempered body: any characters that do not close `tag`. Keeps a lazy
 * match from running across a sibling element of the same kind.
 */
const inside = (tag: string) => `(?:(?!</${tag}>)[\\s\\S])*?`

describe("sentences wrap the number, not the sentence", () => {
  const COUNTER = (expr: string) => `<span className="type-counter">{${expr}}</span>`

  const SITES: { name: string; file: string; pattern: RegExp; counters: string[] }[] = [
    {
      name: "living answer — 'Updated … · N sources'",
      file: "components/saved/living-answer.tsx",
      pattern: new RegExp(`<div className="(?<cls>[^"]*)">\\s*(?<body>Updated ${inside("div")})</div>`),
      counters: ["itemCount + excerptCount"],
    },
    {
      name: "living answer — 'N items · N excerpts'",
      file: "components/saved/living-answer.tsx",
      pattern: new RegExp(
        `<span className="(?<cls>[^"]*)">\\s*(?<body>(?:<span className="type-counter">)?\\{itemCount\\}${inside("div")}"excerpts"\\})\\s*</span>`
      ),
      counters: ["itemCount", "excerptCount"],
    },
    {
      name: "stories list — 'N of M stories'",
      file: "components/stories/stories-list.tsx",
      pattern: new RegExp(
        `<span className="(?<cls>[^"]*)">\\s*(?<body>(?:<span className="type-counter">)?\\{filteredStories\\.length\\}${inside("div")}stories)\\s*</span>`
      ),
      counters: ["filteredStories.length", "stories.length"],
    },
    {
      name: "admin — comp badge 'Comp · Nd'",
      file: "components/admin/admin-dashboard.tsx",
      pattern: new RegExp(`<Badge(?<cls>[^>]*)>(?<body>${inside("Badge")}Comp · ${inside("Badge")})</Badge>`),
      counters: ["comp.daysLeft"],
    },
    {
      name: "admin — '(Nd left)'",
      file: "components/admin/admin-dashboard.tsx",
      pattern: new RegExp(
        `<span className="(?<cls>[^"]*)">(?<body>\\((?:<span className="type-counter">)?\\{comp\\.daysLeft\\}(?:</span>)?d left\\))</span>`
      ),
      counters: ["comp.daysLeft"],
    },
    {
      name: "collection card — saved-item and excerpt counts",
      file: "components/saved/collection-card.tsx",
      pattern: new RegExp(`<div className="(?<cls>[^"]*pt-1[^"]*)">(?<body>${inside("div")})</div>`),
      counters: ["collection.itemCount", "collection.excerptCount"],
    },
    {
      name: "story card — 'N src.'",
      file: "components/stories/story-card.tsx",
      pattern: /<span className="(?<cls>flex items-center gap-1[^"]*)">(?<body>[\s\S]{0,400}?\ssrc\.)\s*<\/span>/,
      counters: ["story._count.inboxItems"],
    },
    {
      name: "onboarding discovery — 'N of M'",
      file: "components/onboarding/feed-discovery-progress.tsx",
      pattern: new RegExp(`<p className="(?<cls>[^"]*)" aria-live="polite" aria-atomic="true">(?<body>${inside("p")})</p>`),
      counters: ["found + notFound", "total"],
    },
  ]

  for (const site of SITES) {
    it(`${site.name}: the container is not tabular and each number is a counter`, () => {
      const m = read(site.file).match(site.pattern)
      expect(m, `${site.file}: the sentence was not found — update the pattern if it moved`).not.toBeNull()
      expect(m!.groups!.cls).not.toMatch(/\btabular-nums\b/)
      for (const expr of site.counters) expect(m!.groups!.body).toContain(COUNTER(expr))
    })
  }
})

describe("the morph primitives render counters", () => {
  it("MorphNumber's plain and rolling roots both carry type-counter", () => {
    const src = read("components/ui/morph-number.tsx")
    const classes = [...src.matchAll(/className=\{cn\("([^"]*)", className\)\}/g)].map((m) => m[1])
    expect(classes).toHaveLength(2)
    for (const c of classes) expect(c.split(" ")).toContain("type-counter")
    // RAD-355's line-box hook stays on the rolling root.
    expect(classes.some((c) => c.split(" ").includes("morph-number"))).toBe(true)
  })

  it("MorphText gives numeric children type-counter", () => {
    const src = read("components/ui/morph-text.tsx")
    expect(src).toMatch(/typeof children === "number" \? cn\("type-counter\b[^"]*", className\) : className/)
  })

  it("string quantities passed to MorphText carry type-counter explicitly", () => {
    // A price and a pre-formatted count are strings, so the automatic class
    // does not reach them.
    expect(read("components/settings/billing-section.tsx")).toMatch(
      /<MorphText className="[^"]*\btype-counter\b[^"]*">\{offer\.price\}<\/MorphText>/
    )
    expect(read("components/admin/admin-dashboard.tsx")).toMatch(
      /<MorphText as="p" className="[^"]*\btype-counter\b[^"]*">\s*\{value\.toLocaleString\(\)\}/
    )
  })
})

describe("headings and tags off the primitives", () => {
  it("the dashboard wordmark follows Headings", () => {
    const src = read("components/layout/dashboard-shell.tsx")
    const m = src.match(new RegExp(`<Link\\s+href="/posts"\\s+className="(?<cls>[^"]*)"\\s*>${inside("Link")}>Radaric</span>`))
    expect(m, "wordmark link not found").not.toBeNull()
    expect(m!.groups!.cls.split(" ")).toContain("type-heading")
  })

  it("SectionLabel is a tag", () => {
    const src = read("components/reading/reading-layout.tsx")
    const body = src.slice(src.indexOf("export function SectionLabel("), src.indexOf("export function ReadingTitle("))
    expect(body).toMatch(/"type-tag\b[^"]*uppercase/)
  })

  it("the sidebar's group label is a tag", () => {
    const m = read("components/layout/sidebar.tsx").match(/<div className="(?<cls>[^"]*)">\s*Sources\s*<\/div>/)
    expect(m, "sidebar group label not found").not.toBeNull()
    expect(m!.groups!.cls.split(" ")).toContain("type-tag")
  })

  it("the category-picker chip is a tag", () => {
    const src = read("components/feeds/content-category-picker.tsx")
    const chip = src.slice(src.indexOf("aria-pressed={selected}"), src.indexOf("{label}"))
    expect(chip).toMatch(/"type-tag\b/)
  })
})
