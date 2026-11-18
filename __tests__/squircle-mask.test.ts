import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { transform } from "lightningcss"
import { join, resolve } from "node:path"

/**
 * Guards the cross-engine corner system in app/globals.css.
 *
 * `corner-shape` is Chromium-only — `CSS.supports` is false for it in every
 * syntax on WebKit — so on an iPhone Radaric's corners were plain circular
 * arcs at a radius scale that had been RAISED to compensate for a superellipse
 * cutting LESS corner than an arc. #101 papered over that by rolling the radius
 * back where the property is missing; masks carry the real shape instead.
 *
 * Every assertion below is something that fails SILENTLY: the corner still
 * looks right in Chrome, which is where it gets reviewed.
 */
const root = resolve(__dirname, "..")
const css = readFileSync(join(root, "app/globals.css"), "utf-8")
/**
 * The `@utility` blocks at the end of the file are nested CSS that Tailwind
 * expands per class, and the text parsing below reads only flat rules. They are
 * pinned on Tailwind's compiled output instead, in squircle-utilities.test.ts;
 * the first test below keeps them at the end, where this cut is safe.
 */
const UTILITIES_AT = css.search(/^@utility /m)
const uncommented = (UTILITIES_AT === -1 ? css : css.slice(0, UTILITIES_AT)).replace(
  /\/\*[\s\S]*?\*\//g,
  "",
)

/**
 * The painted ring is the one masked rule that is not a shape: six layers, the
 * border box minus the content box's squircle. It is pinned by its own test
 * below and kept out of the shape guards, which would read its layers as a
 * malformed surface.
 *
 * Anchored on the state GUARD, not on a bare `[class*="rounded"]::after`: the
 * paint must only reach our own ring pseudo, never a library's — Sonner's
 * expanded-toast gap strip is `content: ''` only and used to inherit this
 * paint. See the note above the rule in globals.css.
 */
const RING_SELECTOR = ':where([class*="rounded"]:is('
const RING_AT = uncommented.indexOf(RING_SELECTOR)
const ringBody = RING_AT === -1 ? "" : uncommented.slice(uncommented.indexOf("{", RING_AT) + 1, uncommented.indexOf("}", RING_AT))
const shapes = RING_AT === -1 ? uncommented : uncommented.replace(ringBody, "")

/** [selector, body] for every rule in the file, in source order. */
const rules = [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (m) => [m[1].trim(), m[2]] as const,
)

describe("squircle masks", () => {
  it("keeps every @utility after the last flat rule, where the cut above is safe", () => {
    // Everything before the first `@utility` is read as text by this file; a
    // flat rule added after it would silently escape every guard below.
    expect(UTILITIES_AT, "the rounded-* utilities must exist").toBeGreaterThan(-1)
    const tail = css.slice(UTILITIES_AT).replace(/\/\*[\s\S]*?\*\//g, "")
    let depth = 0
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] === "{") depth++
      if (tail[i] === "}") depth--
      if (depth === 0 && tail[i] === "}") {
        const next = tail.slice(i + 1).trimStart()
        expect(next === "" || next.startsWith("@utility "), `flat CSS after @utility: ${next.slice(0, 60)}`).toBe(true)
      }
    }
  })

  it("paints the ring as the border box minus the content box's squircle, prefixed and standard", () => {
    expect(RING_AT, "the flat painted-ring rule").toBeGreaterThan(-1)
    const body = ringBody.replace(/\s+/g, " ")
    expect(body).toContain("--tw-ring-color: inherit;")
    const corners = ["tl", "tr", "br", "bl"].map((c) => `var(--sq-${c}-ri) var(--sq-${c}-ri)`).join(", ")
    for (const prefix of ["-webkit-", " "]) {
      expect(body).toContain(`${prefix}mask-size: ${corners}, 100% 100%, 100% 100%;`)
      expect(body).toContain(`${prefix}mask-origin: content-box, content-box, content-box, content-box, border-box, content-box;`)
    }
    expect(body).toContain("-webkit-mask-composite: source-over, source-over, source-over, source-over, source-out, source-over;")
    expect(body).toContain(" mask-composite: add, add, add, add, subtract, add;")
    // A negative inner corner would be invalid and drop the whole mask.
    expect(body).toMatch(/--sq-tl-ri: max\(0px,/)
  })

  it("arms the painted ring only while the ring state is on, so a library's own ::after is left alone", () => {
    // The rule can only paint where OUR `content` switch is on. It used to
    // match every rounded element, and a library that generates its own
    // `::after` — Sonner's expanded-toast gap strip is `content: ''` and
    // nothing else — inherited this paint wholesale: a green (`var(--ring)`,
    // the fallback) crescent through the notch mask at the toast's top
    // corners, on hover of anything over the toaster (the profile chip shares
    // its corner). The state list therefore has to EQUAL the `content`
    // switch's in `@utility squircle-shape`: a state added to one without the
    // other reopens the hole or drops a ring.
    expect(uncommented, "the unguarded selector is back").not.toContain(
      ':where([class*="rounded"])::after',
    )

    /** The argument of the first `:is(…)` after `anchor`, balanced-paren aware. */
    const isList = (source: string, anchor: string) => {
      const at = source.indexOf(anchor)
      expect(at, `anchor ${anchor}`).toBeGreaterThan(-1)
      const open = source.indexOf(":is(", at)
      let depth = 0
      for (let i = open + 3; i < source.length; i++) {
        if (source[i] === "(") depth++
        if (source[i] === ")") {
          depth--
          if (depth === 0) return source.slice(open + 4, i).replace(/\s+/g, " ").trim()
        }
      }
      throw new Error(`unbalanced :is() after ${anchor}`)
    }

    const ringList = isList(uncommented, RING_SELECTOR)
    const switchList = isList(css.slice(UTILITIES_AT), "&:is(")
    expect(ringList).toBe(switchList)
    expect(ringList).toContain('[class~="ring-1"]')
  })

  it("keeps the -webkit-mask-composite twin on every masked rule", () => {
    // Safari IS the reason this exists. Dropping the prefixed value would leave
    // the standard one working in Chromium and nothing at all on the one engine
    // the mask was written for.
    // Keyed on `mask-image`, NOT on `mask-composite`: keying on the declaration
    // under test quietly exempts the rule that forgets it, and a masked rule
    // with no composite renders the notches source-over UNDER the fill — no
    // squircle at all, whole suite green.
    const masked = rules.filter(([selector, body]) => !selector.startsWith(RING_SELECTOR) && /(^|[\s;])(-webkit-)?mask-image:/.test(body))
    expect(masked.length).toBeGreaterThan(0)
    for (const [selector, body] of masked) {
      // Whitespace-insensitive: prettier reflows a long declaration onto its own
      // line, and pinning its line breaks makes this fail on formatting alone.
      const flat = body.replace(/\s+/g, " ")
      // The operator list is exactly as long as the layer list, so derive its
      // width from the rule's own layers: four corners on a surface, two on a
      // band flush with the top edge.
      const n = (body.match(/(?:^|[\s;])mask-size:([^;]+);/)?.[1] ?? "").split(",").length
      expect(n, `${selector} must declare mask-size`).toBeGreaterThan(1)
      // `subtract`, never `exclude`/`xor` — see the note in globals.css. XOR
      // agrees with subtraction only while the notches are disjoint, and stops
      // the moment an element is under 2 × --sq-r in either axis.
      const ops = (head: string, rest: string) => [head, ...Array(n - 1).fill(rest)].join(", ")
      expect(flat, selector).toContain(
        `-webkit-mask-composite: ${ops("source-out", "source-over")};`,
      )
      expect(flat, selector).toContain(`mask-composite: ${ops("subtract", "add")};`)
      // Both halves come from a hoisted list, prefixed and standard.
      const list = body.includes("var(--sq-mask-top)") ? "--sq-mask-top" : "--sq-mask"
      expect(body.match(new RegExp(`var\\(${list}\\)`, "g"))?.length, selector).toBe(2)
      expect(body.match(new RegExp(`var\\(${list}-position\\)`, "g"))?.length, selector).toBe(2)
      // An arc cuts MORE corner than the superellipse inside it, so a surviving
      // border-radius clips the notch away and the mask becomes invisible.
      // Checked per simple selector: a grouped rule would otherwise pass on the
      // strength of one `::before` in the group.
      for (const simple of selector.split(",").map((x) => x.trim())) {
        if (/::(before|after)/.test(simple)) continue // a pseudo starts at 0 anyway
        expect(/border-radius:\s*0;/.test(body), `${simple} must zero border-radius`).toBe(true)
      }
    }
  })

  it("never sizes a mask layer independently of its element", () => {
    // THE regression this file exists for. The shape used to be four whole
    // boxes intersected, each sized `calc(var(--sq-r) * 100)` — a fixed 1800px
    // at --radius-xl. Below that everything painted; between 1800 and 3600 only
    // the band [size − 1800, 1800] did; past 3600 nothing did. A production list
    // shipped that form and lost its background with every suite green,
    // because nothing in the repo rendered anything.
    //
    // So: a corner is allowed to be an absolute length, and the layer that
    // FILLS the box is not. Any other value is a ceiling waiting to be hit.
    const decls = [...shapes.matchAll(/(?:-webkit-)?mask-size:([^;]+);/g)].map((m) =>
      m[1].replace(/\s+/g, " ").trim(),
    )
    // A regex that matched nothing would pass every assertion below. Every
    // masked rule declares the size twice, prefixed and standard, so the count
    // is pinned to the mask-image declarations rather than to a literal: a new
    // masked rule that declares no mask-size cannot slip past.
    const images = [...shapes.matchAll(/(?:-webkit-)?mask-image:/g)].length
    expect(decls.length, "one mask-size per mask-image, prefixed and standard").toBe(images)
    expect(decls.length).toBeGreaterThanOrEqual(4)

    for (const decl of decls) {
      const layers = decl.split(",").map((l) => l.trim())
      // 5 on a surface (fill + four corners), 3 on a top band (fill + two).
      expect([3, 5], decl).toContain(layers.length)
      expect(layers[0], `fill layer in \`${decl}\``).toBe("100% 100%")
      for (const layer of layers.slice(1)) {
        expect(layer, `corner layer in \`${decl}\``).toBe("var(--sq-r) var(--sq-r)")
      }
    }

    // mask-size is POSITIONAL, so the layer list IS the geometry: its order,
    // its length and its anchors all matter, and every assertion above stays
    // green without them. Two edits prove it — drop `var(--sq-bl)` and the
    // surplus fifth size is silently ignored while one corner goes square;
    // move the gradient to the end and the fill is sized 18px while a corner is
    // stretched to 100%. Both catastrophic, both look like nothing.
    //
    // A layer list cannot be split on every comma — `linear-gradient(#fff,
    // #fff)` carries one of its own — so split only at depth zero.
    const layerList = (prop: string) => {
      const raw = uncommented.match(new RegExp(`--sq-${prop}:([^;]+);`))?.[1]
      if (raw === undefined) return undefined
      const out: string[] = []
      let depth = 0
      let current = ""
      for (const ch of raw) {
        if (ch === "(") depth++
        if (ch === ")") depth--
        if (ch === "," && depth === 0) {
          out.push(current)
          current = ""
          continue
        }
        current += ch
      }
      out.push(current)
      return out.map((l) => l.replace(/\s+/g, " ").trim())
    }

    expect(layerList("mask"), "the fill first, then tl/tr/br/bl").toEqual([
      "linear-gradient(#fff, #fff)",
      "var(--sq-tl)",
      "var(--sq-tr)",
      "var(--sq-br)",
      "var(--sq-bl)",
    ])
    expect(
      layerList("mask-position"),
      "the fill at the origin, each corner on its own corner",
    ).toEqual(["0 0", "top left", "top right", "bottom right", "bottom left"])

    // The top-band variant cuts the TOP two corners only: its lower corners sit
    // inside the card, and notching them would bite a hole out of the middle.
    expect(layerList("mask-top"), "the fill first, then tl/tr").toEqual([
      "linear-gradient(#fff, #fff)",
      "var(--sq-tl)",
      "var(--sq-tr)",
    ])
    expect(layerList("mask-top-position")).toEqual(["0 0", "top left", "top right"])
  })

  it("sets --sq-r on every rung of the radius ladder", () => {
    // A masked element wears its rung as a Tailwind utility, so --sq-r has to
    // follow the ladder rather than restate it: a rung with no override draws
    // the DEFAULT corner while the unmasked parts of the element draw the rung,
    // and the two disagree by a few pixels — invisible in review, wrong on
    // screen. The ladder lives in the `@theme inline` block of this same file
    // (Tailwind v4 — tailwind.config.ts carries no radius scale), so it is read
    // from there rather than listed here.
    const rungs = [...uncommented.matchAll(/^\s*--radius-([a-z0-9]+):/gm)].map((m) => m[1])
    expect(rungs.length, "the @theme radius ladder").toBeGreaterThanOrEqual(5)

    const defaultRung = uncommented.match(/--sq-r:\s*var\(--radius-([a-z0-9]+)\);/)?.[1]
    expect(defaultRung, "the mask rules must default --sq-r to a rung").toBeDefined()

    for (const rung of rungs) {
      if (rung === defaultRung) continue
      const override = new RegExp(
        `\\[class~="rounded-${rung}"\\][^{]*\\{[^}]*--sq-r:\\s*var\\(--radius-${rung}\\)`,
      )
      expect(override.test(uncommented), `rounded-${rung} has no --sq-r override`).toBe(true)
    }
  })

  it("never puts a mask and a filter on the same element", () => {
    // Masking is applied AFTER filtering, so the two cancel out: the
    // drop-shadow is generated and then clipped away by the very mask that
    // shaped it, and the element renders with no shadow at all. The mask has to
    // live on a ::before and the filter on its host.
    //
    // Compared across the whole file, not rule by rule: the shipped version of
    // this bug had the mask and the filter in two DIFFERENT rules pointing at
    // the same class, which no per-rule check would have caught.
    const withMask = new Set<string>()
    const withFilter = new Set<string>()
    for (const [selector, body] of rules) {
      const simple = selector
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[.:a-z-]+$/i.test(s))
      if (body.includes("mask-composite")) simple.forEach((s) => withMask.add(s))
      if (/(^|[\s;])filter:\s*(?!none)/.test(body))
        simple.forEach((s) => withFilter.add(s))
    }
    expect(withMask.size).toBeGreaterThan(0)
    expect(withFilter.size).toBeGreaterThan(0)
    const both = [...withMask].filter((s) => withFilter.has(s))
    expect(both, "these both mask and filter, so they render no shadow").toEqual([])
  })

  it("isolates every host whose ::before carries the shape", () => {
    // The pseudo sits at z-index -1 so the card's own children paint above it,
    // and without a stacking context on the host that -1 escapes behind the
    // nearest ancestor's background. `filter` happens to create one too, but it
    // must not be the ONLY thing doing so: `.corner-round` sets `filter: none`.
    const pseudoHosts = rules
      .filter(([sel, body]) => sel.includes("::before") && body.includes("mask-composite"))
      .flatMap(([sel]) => sel.split(",").map((s) => s.trim().replace("::before", "")))
    expect(pseudoHosts.length).toBeGreaterThan(0)
    for (const host of pseudoHosts) {
      const declaring = rules.filter(
        ([sel]) => sel.split(",").some((s) => s.trim() === host) && sel.includes(host),
      )
      const isolated = declaring.some(([, body]) => /isolation:\s*isolate/.test(body))
      expect(isolated, `${host} needs isolation: isolate`).toBe(true)
    }
  })

  it("keeps the .icon-tile ratio AFTER the rule that defaults --sq-r", () => {
    // --sq-r is a custom property at plain class specificity, so this one only
    // wins by source order — and it silently loses if the default moves below.
    const defaultAt = uncommented.lastIndexOf("--sq-r: var(--radius-xl)")
    const ratioAt = uncommented.indexOf("--sq-r: calc(var(--tile-size")
    expect(defaultAt).toBeGreaterThan(-1)
    expect(ratioAt).toBeGreaterThan(defaultAt)
  })

  it("parses as valid CSS", () => {
    // The delimiter count below catches the specific bug that shipped; this
    // catches the CLASS. Every other assertion in this file reads the
    // stylesheet as TEXT, so a rule stranded outside a comment still greps
    // fine — which is exactly how `.surface-card.corner-round::before`
    // disappeared from the built bundle with the suite green. A parser sees it:
    // the orphaned prose becomes the next rule's selector prelude and the rule
    // is dropped ("Pseudo-elements like '::before' can't be followed by
    // selectors like 'suppression'").
    const { warnings = [] } = transform({
      filename: "globals.css",
      code: Buffer.from(css),
      errorRecovery: true,
    })
    // Tailwind v4's own at-rules are legitimately unknown to lightningcss.
    const real = warnings.filter((w) => w.type !== "AtRuleInvalid")
    expect(real, "globals.css must contain no unparseable rule").toEqual([])
  })

  it("has balanced comment delimiters", () => {
    // This file is mostly prose, and an unbalanced `*/` is invisible to every
    // other assertion here: they read the file as TEXT, so a rule stranded
    // outside a comment still greps fine. A browser drops it. That is exactly
    // how `.surface-card.corner-round::before` vanished from the production
    // bundle while the suite stayed green and computed style — which reports
    // declarations, not pixels — still looked right.
    const open = (css.match(/\/\*/g) ?? []).length
    const close = (css.match(/\*\//g) ?? []).length
    expect(close, "a stray */ strands the rule that follows it").toBe(open)
  })

  it("parses every load-bearing rule as its own selector", () => {
    // The same failure caught from the other side, and the reason this checks
    // PARSED selectors rather than text: with a stray `*/` above it, the
    // orphaned prose is swallowed into the following rule's selector, so the
    // string `.surface-card.corner-round::before` still greps fine while the
    // rule it names no longer exists. Compare against the split selector list.
    const selectors = new Set(rules.flatMap(([sel]) => sel.split(",").map((x) => x.trim())))
    for (const selector of [
      ".surface-card.corner-round::before",
      ".surface-card::before",
      ".surface-mask",
      ".surface-mask-top",
    ]) {
      expect([...selectors], `${selector} must parse as a rule of its own`).toContain(selector)
    }
  })

  it("keeps .corner-round's paint out of @layer utilities", () => {
    // `.surface-card.corner-round` is (0,2,0). Tailwind emits `.bg-primary-subtle`
    // / `.ring-1` / `.shadow-xl` into @layer utilities at (0,1,0), so in that
    // same layer the escape hatch outranks every utility its call sites depend
    // on — and the hatch that exists to PRESERVE a meaningful outline destroys
    // it. Measured before the fix: `corner-round bg-primary-subtle ring-1
    // ring-inset ring-primary/25` computed to rgb(255,255,255) with no ring.
    // Layer order beats specificity, so the paint sits one layer down.
    const open = css.indexOf("@layer utilities {")
    expect(open).toBeGreaterThan(-1)
    let depth = 0
    let close = open
    for (let i = css.indexOf("{", open); i < css.length; i++) {
      if (css[i] === "{") depth++
      if (css[i] === "}") depth--
      if (depth === 0) {
        close = i
        break
      }
    }
    const utilities = css.slice(open, close)
    expect(utilities).toContain(".surface-card.corner-round::before")
    // The ::before suppression has to stay — it outranks `.surface-card::before`
    // in this same layer. Only the paint declarations move.
    // `filter: none` is the one declaration that must stay here — see the
    // sibling test — so assert on the PAINT properties rather than on the
    // rule's absence, which would just move the bug.
    const inUtilities = utilities.match(/\.surface-card\.corner-round\s*\{([^}]*)\}/)?.[1] ?? ""
    for (const prop of ["background", "box-shadow", "border-radius"]) {
      expect(inUtilities, `${prop} must not sit in @layer utilities`).not.toMatch(
        new RegExp(`(^|[\\s;])${prop}:`),
      )
    }
    expect(css.slice(close)).toMatch(
      /@layer components\s*\{[\s\S]*\.surface-card\.corner-round\s*\{[^}]*background:/,
    )
  })

  it("keeps .corner-round's filter where it can still win", () => {
    // The layer move is a two-edged tool. Dropping the whole rule into
    // `components` lets the call site's Tailwind utilities win — which is the
    // point — but it also lets `.surface-card { filter: var(--filter-card) }`
    // in `utilities` win, so `filter: none` goes inert and an opted-out card
    // keeps the drop-shadow on top of its own box-shadow. `filter` collides
    // with a project rule, not with a utility, so it stays one layer up.
    //
    // This is also what makes the `isolation: isolate` note true: that rule
    // exists because `filter` must not be the only thing establishing the
    // stacking context, which requires `filter: none` to actually apply.
    const layerAt = css.indexOf("@layer utilities {")
    let depth = 0
    let close = layerAt
    for (let i = css.indexOf("{", layerAt); i < css.length; i++) {
      if (css[i] === "{") depth++
      if (css[i] === "}") depth--
      if (depth === 0) {
        close = i
        break
      }
    }
    const utilities = css.slice(layerAt, close)
    const components = css.slice(close)
    expect(utilities, "filter: none must stay in @layer utilities").toMatch(
      /\.surface-card\.corner-round\s*\{[^}]*filter:\s*none/,
    )
    expect(components, "a filter one layer down is inert").not.toMatch(
      /@layer components[\s\S]*\.surface-card\.corner-round\s*\{[^}]*filter:/,
    )
  })

  it("never paints a focus ring the ::before can cover", () => {
    // The pseudo is a negative-z child, and a negative-z child paints AFTER the
    // host's own background and box-shadow (CSS 2.1 Appendix E, step 4 vs 2-3).
    // So an inset ring on a masked host is drawn and then covered by an opaque
    // ::before — computed style says rgb(52,168,90) 2px inset, the screen says
    // white at every offset, in both engines. An outline paints last of all.
    const hosts = new Set(
      rules
        .filter(([sel, body]) => sel.includes("::before") && body.includes("mask-composite"))
        .flatMap(([sel]) => sel.split(",").map((x) => x.trim().replace("::before", ""))),
    )
    expect(hosts.size).toBeGreaterThan(0)
    for (const [selector, body] of rules) {
      if (!selector.includes(":focus")) continue
      const touchesHost = selector
        .split(",")
        .some((x) => hosts.has(x.trim().replace(/:focus[a-z-]*/g, "").replace(/-interactive$/, "")))
      if (!touchesHost) continue
      expect(/box-shadow:\s*inset/.test(body), `${selector} ring would be covered`).toBe(false)
      expect(/outline:\s*none/.test(body), `${selector} must not remove the outline`).toBe(false)
      expect(/outline:\s*\d/.test(body), `${selector} needs a real outline`).toBe(true)
    }
  })

  it("no longer rolls the radius back for engines without corner-shape", () => {
    // #101's fallback existed only because the shape could not render there.
    // The one `@supports not` left in the flat text makes a ring host a
    // containing block for its painted ring; it must never touch a radius.
    const blocks = [...uncommented.matchAll(/@supports not \(corner-shape[^{]*\{/g)].map((m) => {
      let depth = 0
      for (let i = m.index! + m[0].length - 1; i < uncommented.length; i++) {
        if (uncommented[i] === "{") depth++
        if (uncommented[i] === "}" && --depth === 0) return uncommented.slice(m.index! + m[0].length, i)
      }
      return uncommented.slice(m.index! + m[0].length)
    })
    for (const block of blocks) {
      expect(block).not.toMatch(/radius|corner-shape:/)
      expect(block).toMatch(/:where\(/)
    }
  })
})

/** Every class the mask is scoped to, plus the classes that feed it. */
const MASKED = ["surface-card", "elevation-card", "source-type-card", "icon-tile"]

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/**
 * Every className that ends up on a masked element, from one file.
 *
 * `<Card>` injects `surface-card` from card.tsx, so its className never spells
 * the class out — sweeping only for the literal string missed the posts list
 * and the stories list, the two highest-traffic surfaces in the product. The
 * JSX tag counts as a masked class list in its own right.
 */
function maskedClassLists(source: string, classes: readonly string[]): string[] {
  const out: string[] = []
  for (const [literal] of source.matchAll(/"[^"\n]*"|`[^`]*`/g)) {
    if (classes.some((c) => new RegExp(`(^|[\\s"\`])${c}([\\s"\`]|$)`).test(literal))) {
      out.push(literal)
    }
  }
  for (const [tag] of source.matchAll(/<Card\b[^>]*>/gs)) out.push(tag)
  // `.corner-round` turns the mask off and restores a real border-radius, so a
  // card wearing it is out of scope for every assertion below.
  return out.filter((literal) => !literal.includes("corner-round"))
}

const SURFACES = ["surface-card", "source-type-card"] as const

describe("nothing outlined is masked", () => {
  it("never composes a ring or a border into a masked className", () => {
    // A hairline does not survive a mask in any form, and nothing but a
    // screenshot shows it: the DOM is unchanged, getBoundingClientRect still
    // reports full size, and tsc/ESLint/vitest all stay green. A card whose
    // outline means something takes .corner-round, which turns the mask off.
    const files = [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "components"))]
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      for (const literal of maskedClassLists(readFileSync(file, "utf-8"), MASKED)) {
        if (/\b(ring-(1|2|inset)|border(-[0-9])?)\b/.test(literal)) {
          offenders.push(`${file.slice(root.length + 1)}: ${literal.slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("never composes overflow-hidden into a masked className", () => {
    // An overflow clip follows `border-radius` — an arc — and an arc cuts MORE
    // corner than the superellipse inside it, so `overflow: hidden` on a masked
    // host clips its own ::before back to an arc and the squircle disappears.
    // Chromium hides it: the `corner-shape` rule in @layer base reshapes the
    // overflow clip to match. WebKit renders the arc, i.e. every iPhone.
    // Measured on an 18px rung, diagonal scan at dpr 4: 4.0-4.5px masked in
    // both engines, 5.0-5.5px in WebKit through an overflow-hidden host (an arc
    // predicts 5.27, the superellipse 4.51).
    //
    // A child that must be clipped takes `.surface-mask` (it spans the whole
    // host) or `.surface-mask-top` (a band flush with the top edge) instead.
    const files = [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "components"))]
    const offenders: string[] = []
    for (const file of files) {
      for (const literal of maskedClassLists(readFileSync(file, "utf-8"), SURFACES)) {
        if (/\boverflow-hidden\b/.test(literal)) {
          offenders.push(`${file.slice(root.length + 1)}: ${literal.slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("never paints a background on a masked host", () => {
    // The ::before carries the background so the mask can shape it. A bg-*
    // utility on the host would paint an unmasked square behind it.
    const files = [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "components"))]
    const offenders: string[] = []
    for (const file of files) {
      for (const literal of maskedClassLists(readFileSync(file, "utf-8"), SURFACES)) {
        if (/\bbg-[a-z]/.test(literal)) {
          offenders.push(`${file.slice(root.length + 1)}: ${literal.slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
