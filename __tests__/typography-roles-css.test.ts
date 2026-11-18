import { beforeAll, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"

/**
 * RAD-363 slice 4 — the four typography roles (text, heading, tag, counter)
 * become real CSS. Pinned on the CSS Tailwind actually EMITS from the real
 * `app/globals.css`, not on its source text (except AC-15, which reads the
 * primitives' className strings). Spec: `.tdd/spec-typography-roles.md`.
 *
 * ERR-1 (a missing `./typography.css` makes the compile throw) has no test of
 * its own: every test here compiles globals.css, and AC-1 surfaces the error.
 */
const root = resolve(__dirname, "..")
const cssPath = join(root, "app/globals.css")

async function emit(...candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(cssPath, "utf-8"), {
    base: dirname(cssPath),
    onDependency: () => {},
  })
  return compiler.build(candidates)
}

/** Bodies of every rule whose selector is exactly `selector`, nested blocks included. */
function rulesFor(css: string, selector: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = css.indexOf(`${selector} {`, from)
    if (at === -1) return out
    const open = css.indexOf("{", at)
    let depth = 0
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++
      if (css[i] === "}") depth--
      if (depth === 0) {
        out.push(css.slice(open + 1, i))
        from = i
        break
      }
    }
  }
}

const flat = (s: string) => s.replace(/\s+/g, " ")

// ---------------------------------------------------------------------------
// A small nested-CSS walker. Tailwind v4 emits native nesting (`.prose { :where(h1) … }`,
// `.md\:x { @media … { … } }`), so a rule's effective selector has to be resolved
// through its ancestors, and its at-rule context (which @layer it sits in) kept.
// ---------------------------------------------------------------------------

interface Rule {
  /** The rule's own prelude, whitespace-normalised. */
  selector: string
  /** Effective selector, resolved through nesting (`&` substituted, else descendant). */
  resolved: string
  /** Every at-rule prelude above this rule, outermost first (e.g. `@layer base`). */
  atPath: string[]
  /** Nesting depth of this rule in the compiled output (0 = top level). */
  depth: number
  /** Direct declarations only (child blocks removed), whitespace-normalised. */
  decls: string
  /** Order of appearance in the output. */
  index: number
}

/** Split a selector list on top-level commas (not inside parens / brackets / strings). */
function splitList(sel: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ""
  for (const ch of sel) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === "(" || ch === "[") depth++
    else if (ch === ")" || ch === "]") depth--
    else if (ch === "," && depth === 0) {
      parts.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function resolveSelector(parent: string | null, own: string): string {
  if (!parent) return own
  const out: string[] = []
  for (const p of splitList(parent)) {
    for (const c of splitList(own)) {
      out.push(c.includes("&") ? c.replaceAll("&", p) : `${p} ${c}`)
    }
  }
  return out.join(", ")
}

function parseRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const rules: Rule[] = []
  let index = 0

  // Returns the position just after the matching `}` of the block that starts at `open`.
  function walk(start: number, end: number, atPath: string[], parentSel: string | null, depth: number) {
    let i = start
    let prelude = ""
    let quote: string | null = null
    while (i < end) {
      const ch = src[i]
      if (quote) {
        prelude += ch
        if (ch === quote) quote = null
        i++
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        prelude += ch
        i++
        continue
      }
      if (ch === ";") {
        // A declaration or a statement at-rule (`@layer a, b;`) at this level.
        prelude = ""
        i++
        continue
      }
      if (ch === "{") {
        const close = matchBrace(i)
        const head = flat(prelude).trim()
        prelude = ""
        if (head.startsWith("@")) {
          // An at-rule nested in a style rule (`.md\:x { @media … { decls } }`)
          // carries declarations for the parent selector.
          if (parentSel) {
            const body = directDecls(i + 1, close)
            if (body) {
              rules.push({ selector: flat(parentSel), resolved: flat(parentSel), atPath: [...atPath, head], depth, decls: body, index: index++ })
            }
          }
          walk(i + 1, close, [...atPath, head], parentSel, depth + 1)
        } else {
          const resolved = resolveSelector(parentSel, head)
          const body = directDecls(i + 1, close)
          rules.push({ selector: head, resolved: flat(resolved), atPath, depth, decls: body, index: index++ })
          walk(i + 1, close, atPath, resolved, depth + 1)
        }
        i = close + 1
        continue
      }
      prelude += ch
      i++
    }
  }

  function matchBrace(open: number): number {
    let depth = 0
    let quote: string | null = null
    for (let i = open; i < src.length; i++) {
      const ch = src[i]
      if (quote) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") quote = ch
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) return i
      }
    }
    throw new Error("unbalanced braces in compiled CSS")
  }

  /** The declarations of a block with every nested child block cut out. */
  function directDecls(start: number, end: number): string {
    let out = ""
    let i = start
    let pending = ""
    while (i < end) {
      const ch = src[i]
      if (ch === "{") {
        // `pending` was a nested prelude, not a declaration.
        pending = ""
        i = matchBrace(i) + 1
        continue
      }
      pending += ch
      if (ch === ";") {
        out += pending
        pending = ""
      }
      i++
    }
    return flat(out).trim()
  }

  walk(0, src.length, [], null, 0)
  return rules
}

const inLayer = (layer: string) => (r: Rule) => r.atPath.some((a) => a === `@layer ${layer}`)
const unlayered = (r: Rule) => !r.atPath.some((a) => a.startsWith("@layer"))
const normList = (sel: string) => splitList(flat(sel)).join(", ")

/** All direct declarations of every rule matching `pred`, joined. */
function declsOf(rules: Rule[], pred: (r: Rule) => boolean): string {
  return rules
    .filter(pred)
    .map((r) => r.decls)
    .join(" ")
}

/** Class selectors in `sel` that count toward specificity (those inside `:where(...)` do not). */
function classSpecificity(sel: string): number {
  let s = sel
  // Strip every :where(...) (balanced), innermost first.
  for (;;) {
    const at = s.indexOf(":where(")
    if (at === -1) break
    let depth = 0
    let end = at + ":where".length
    for (; end < s.length; end++) {
      if (s[end] === "(") depth++
      if (s[end] === ")") {
        depth--
        if (depth === 0) break
      }
    }
    s = s.slice(0, at) + s.slice(end + 1)
  }
  // Attribute selectors like [class~="not-prose"] carry a class-level weight too,
  // but the plugin's are all inside :where(); count `.name` and `[attr]` alike.
  const classes = s.match(/\.(?:\\.|[A-Za-z0-9_-])+/g) ?? []
  const attrs = s.match(/\[[^\]]+\]/g) ?? []
  return classes.length + attrs.length
}

const ROLES = [
  { role: "text", selector: "body, .type-text, [data-sonner-toaster]" },
  { role: "heading", selector: "h1, h2, h3, h4, h5, h6, .type-heading" },
  { role: "tag", selector: ".type-tag" },
  { role: "counter", selector: ".type-counter, [data-numeric]" },
] as const

const WEIGHTS = [
  ["thin", 100],
  ["extralight", 200],
  ["light", 300],
  ["normal", 400],
  ["medium", 500],
  ["semibold", 600],
  ["bold", 700],
  ["extrabold", 800],
  ["black", 900],
] as const

const mapped = (n: number) => `font-weight: calc(${n} * var(--type-wa, 1) + var(--type-wb, 0));`

describe("typography roles — globals.css (RAD-363 slice 4)", () => {
  let baseRules: Rule[] = []
  let baseCss = ""

  beforeAll(async () => {
    baseCss = await emit()
    baseRules = parseRules(baseCss).filter(inLayer("base"))
  })

  it("AC-1: imports ./typography.css into @layer base and registers @property --type-w (<number>, inherited, 400)", async () => {
    const css = await emit()
    const base = declsOf(parseRules(css), inLayer("base"))
    expect(base).toMatch(/--f-inter-text-family: [^;]+;/)
    expect(base).toContain("--type-text-family: var(--f-inter-text-family);")

    const prop = rulesFor(css, "@property --type-w").map(flat)
    expect(prop).toHaveLength(1)
    expect(prop[0]).toContain('syntax: "<number>";')
    expect(prop[0]).toContain("inherits: true;")
    expect(prop[0]).toContain("initial-value: 400;")
  })

  it("AC-2: every font-<weight> utility maps its weight through the font and sets --type-w", async () => {
    const css = await emit(...WEIGHTS.map(([name]) => `font-${name}`))
    const rules = parseRules(css)
    for (const [name, n] of WEIGHTS) {
      const body = declsOf(rules, (r) => r.selector === `.font-${name}`)
      expect(body, `.font-${name} font-weight`).toContain(mapped(n))
      expect(body, `.font-${name} --type-w`).toContain(`--type-w: ${n};`)
    }
  })

  it("AC-3: md: and data-[state=open]: variants of font-semibold carry both the mapped weight and --type-w", async () => {
    const css = await emit("md:font-semibold", "data-[state=open]:font-semibold")
    const rules = parseRules(css)
    for (const sel of [".md\\:font-semibold", ".data-\\[state\\=open\\]\\:font-semibold"]) {
      // The declarations sit in a child block (@media / &[data-state]) — collect
      // every rule whose resolved selector starts from the variant class.
      const body = declsOf(rules, (r) => r.resolved.startsWith(sel))
      expect(body, `${sel} font-weight`).toContain(mapped(600))
      expect(body, `${sel} --type-w`).toContain("--type-w: 600;")
    }
  })

  it("AC-4: @layer base holds the four role rules with exact selector lists in text → heading → tag → counter order", () => {
    const positions = ROLES.map(({ selector }) => {
      const hit = baseRules.find((r) => normList(r.selector) === selector)
      return hit ? hit.index : -1
    })
    expect(positions.map((p) => p > -1)).toEqual([true, true, true, true])
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })

  it("AC-5: each role rule binds the font and publishes the role's adaptation values", () => {
    for (const { role, selector } of ROLES) {
      const body = declsOf(baseRules, (r) => normList(r.selector) === selector)
      const expected = [
        `--type-wa: var(--type-${role}-wa);`,
        `--type-wb: var(--type-${role}-wb);`,
        `--type-features: var(--type-${role}-features);`,
        `--type-caps-adjust: var(--type-${role}-caps-adjust);`,
        `--type-df: var(--type-${role}-df);`,
        `--type-cf: var(--type-${role}-cf);`,
        `--type-leading: var(--type-${role}-leading);`,
        `font-family: var(--type-${role}-family);`,
        `font-stretch: var(--type-${role}-stretch);`,
        `font-size-adjust: var(--type-${role}-size-adjust);`,
        `font-feature-settings: var(--type-${role}-features);`,
        "font-weight: calc(var(--type-w) * var(--type-wa) + var(--type-wb));",
      ]
      for (const decl of expected) {
        expect(body, `${role}: ${decl}`).toContain(decl)
      }
      if (role === "counter") {
        expect(body).toContain("font-variant-numeric: tabular-nums;")
      }
    }
  })

  it("AC-6: uppercase composes the font's features with case and applies the caps size adjust", async () => {
    const rules = parseRules(await emit("uppercase")).filter((r) => r.selector === ".uppercase")
    const all = rules.map((r) => r.decls).join(" ")
    expect(all).toContain("text-transform: uppercase;")
    const withCase = rules.find((r) => r.decls.includes('font-feature-settings: var(--type-features), "case";'))
    expect(withCase?.decls ?? "").toContain("font-size-adjust: var(--type-caps-adjust);")
  })

  it("AC-7: no rule selecting .tabular-nums declares font-feature-settings; tabular-nums still emits font-variant-numeric", async () => {
    const rules = parseRules(await emit("tabular-nums"))
    const offenders = rules
      .filter((r) => r.resolved.includes(".tabular-nums") && r.decls.includes("font-feature-settings"))
      .map((r) => `${r.resolved} { ${r.decls} }`)
    expect(offenders).toEqual([])
    const utility = declsOf(rules, (r) => r.selector === ".tabular-nums" && inLayer("utilities")(r))
    expect(utility).toContain("--tw-numeric-spacing: tabular-nums;")
    expect(utility).toMatch(/font-variant-numeric: [^;]*var\(--tw-numeric-spacing,\)/)
  })

  it("AC-8: tracking scales by the display factor (negative) or caps factor (positive), headings included", async () => {
    const expected: Record<string, string> = {
      "tracking-tighter": "calc(-0.05em * var(--type-df, 1))",
      "tracking-tight": "calc(-0.025em * var(--type-df, 1))",
      "tracking-wide": "calc(0.025em * var(--type-cf, 1))",
      "tracking-wider": "calc(0.05em * var(--type-cf, 1))",
      "tracking-widest": "calc(0.1em * var(--type-cf, 1))",
    }
    const rules = parseRules(await emit(...Object.keys(expected)))
    for (const [cls, value] of Object.entries(expected)) {
      expect(declsOf(rules, (r) => r.selector === `.${cls}`), cls).toContain(`letter-spacing: ${value};`)
    }
    expect(declsOf(baseRules, (r) => normList(r.selector) === "h1, h2, h3")).toContain(
      "letter-spacing: calc(-0.02em * var(--type-df, 1));",
    )
    expect(declsOf(baseRules, (r) => r.selector === "h1")).toContain(
      "letter-spacing: calc(-0.025em * var(--type-df, 1));",
    )
  })

  it("AC-9: text-* line heights and named leading-* scale by --type-leading; leading-none stays 1", async () => {
    const ratio: Record<string, [string, string]> = {
      "text-xs": ["1", "0.75"],
      "text-sm": ["1.25", "0.875"],
      "text-base": ["1.5", "1"],
      "text-lg": ["1.75", "1.125"],
      "text-xl": ["1.75", "1.25"],
      "text-2xl": ["2", "1.5"],
      "text-3xl": ["2.25", "1.875"],
      "text-4xl": ["2.5", "2.25"],
    }
    const big = ["text-5xl", "text-6xl", "text-7xl", "text-8xl", "text-9xl"]
    const leading: Record<string, string> = {
      "leading-tight": "1.25",
      "leading-snug": "1.375",
      "leading-normal": "1.5",
      "leading-relaxed": "1.625",
      "leading-loose": "2",
    }
    const rules = parseRules(
      await emit(...Object.keys(ratio), ...big, ...Object.keys(leading), "leading-none"),
    )
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

    for (const [cls, [a, b]] of Object.entries(ratio)) {
      const body = declsOf(rules, (r) => r.selector === `.${cls}`)
      // `calc(calc(a / b) * var(--type-leading, 1))` or `calc(a / b * var(--type-leading, 1))`.
      const re = new RegExp(
        `line-height: var\\(--tw-leading, calc\\((?:calc\\(${esc(a)} / ${esc(b)}\\)|${esc(a)} / ${esc(b)}) \\* var\\(--type-leading, 1\\)\\)\\);`,
      )
      expect(body, cls).toMatch(re)
    }
    for (const cls of big) {
      expect(declsOf(rules, (r) => r.selector === `.${cls}`), cls).toContain(
        "line-height: var(--tw-leading, calc(1 * var(--type-leading, 1)));",
      )
    }
    for (const [cls, n] of Object.entries(leading)) {
      expect(declsOf(rules, (r) => r.selector === `.${cls}`), cls).toContain(
        `line-height: calc(${n} * var(--type-leading, 1));`,
      )
    }
    expect(declsOf(rules, (r) => r.selector === ".leading-none")).toContain("line-height: 1;")
  })

  it("AC-10: b, strong, th map weight 700 through the font, after the role rules", () => {
    const bold = baseRules.find((r) => normList(r.selector) === "b, strong, th")
    expect(bold?.decls ?? "").toContain("--type-w: 700;")
    expect(bold?.decls ?? "").toContain("font-weight: calc(700 * var(--type-wa) + var(--type-wb));")
    const lastRole = Math.max(
      ...ROLES.map(({ selector }) => baseRules.find((r) => normList(r.selector) === selector)?.index ?? Infinity),
    )
    expect((bold?.index ?? -1) > lastRole).toBe(true)
  })

  it("AC-11: code faces reset the map — base code/kbd/pre/samp and the font-mono utility", async () => {
    const expected = [
      "--type-wa: 1;",
      "--type-wb: 0;",
      '--type-features: "kern";',
      'font-feature-settings: "kern";',
      "font-stretch: 100%;",
      "font-size-adjust: none;",
      "font-weight: var(--type-w);",
      "--type-caps-adjust: none;",
      "--type-df: 1;",
      "--type-cf: 1;",
      "--type-leading: 1;",
    ]
    const base = declsOf(baseRules, (r) => normList(r.selector) === "code, kbd, pre, samp")
    const mono = declsOf(parseRules(await emit("font-mono")), (r) => r.selector === ".font-mono")
    for (const decl of expected) {
      expect(base, `code, kbd, pre, samp: ${decl}`).toContain(decl)
      expect(mono, `.font-mono: ${decl}`).toContain(decl)
    }
  })

  it("AC-12: body declares no font-feature-settings of its own; --font-sans is var(--type-text-family)", async () => {
    const body = declsOf(baseRules, (r) => r.selector === "body")
    expect(body).toContain("background-color: var(--background);")
    expect(body).not.toContain("font-feature-settings")
    const sans = declsOf(parseRules(await emit("font-sans")), (r) => r.selector === ".font-sans")
    expect(sans).toContain("font-family: var(--type-text-family);")
  })

  it("AC-13: an unlayered rule forces Sonner's toaster onto the text family", () => {
    const toaster = parseRules(baseCss).filter(
      (r) => unlayered(r) && r.depth === 0 && normList(r.selector).split(", ").includes("[data-sonner-toaster]"),
    )
    expect(toaster.map((r) => r.decls).join(" ")).toContain("font-family: var(--type-text-family) !important;")
  })

  it("AC-13b: unlayered !important rules map Sonner's literal title, button and description weights", () => {
    const unl = parseRules(baseCss).filter((r) => unlayered(r) && r.depth === 0)
    const want: Array<[string, number]> = [
      ["[data-sonner-toast] [data-title]", 500],
      ["[data-sonner-toast] [data-button]", 500],
      ["[data-sonner-toast] [data-description]", 400],
    ]
    for (const [sel, n] of want) {
      const hits = unl.filter((r) => normList(r.selector).split(", ").includes(sel))
      expect(hits.map((r) => r.decls).join(" "), sel).toContain(
        `font-weight: calc(${n} * var(--type-wa) + var(--type-wb)) !important;`,
      )
    }
  })

  it("AC-14: prose-ink re-expresses the plugin's literal prose weights through the map, above (0,1,0)", async () => {
    const rules = parseRules(await emit("prose", "prose-ink"))
    const want: Array<[string, number]> = [
      ["h1", 800],
      ["h2", 700],
      ["h3", 600],
      ["h4", 600],
      ["strong", 600],
      ["a", 500],
      ["thead th", 600],
      ["dt", 600],
      ["h1 strong", 900],
      ["h2 strong", 800],
      ["h3 strong", 700],
      ["h4 strong", 700],
    ]
    // `.prose` as a class of its own — `.prose-ink` contains the substring.
    const proseClass = /\.prose(?![\w-])/
    const candidates = rules.filter((r) => r.resolved.includes(".prose-ink") && proseClass.test(r.resolved))
    for (const [el, n] of want) {
      const elRe = new RegExp(`(^|[\\s(,>])${el.replace(" ", "\\s+")}(?=[\\s),:.\\[]|$)`)
      const hits = candidates.filter(
        (r) =>
          splitList(r.resolved).some((s) => elRe.test(s)) &&
          r.decls.includes(`--type-w: ${n};`) &&
          r.decls.includes(mapped(n)),
      )
      expect(hits.length, `${el} → ${n}`).toBeGreaterThan(0)
      const spec = Math.max(
        ...hits.flatMap((r) => splitList(r.resolved).filter((s) => elRe.test(s)).map(classSpecificity)),
      )
      expect(spec, `${el} specificity (classes)`).toBeGreaterThanOrEqual(2)
    }
  })

  it("AC-14b: the heading-strong weights come after prose-ink's plain strong rule, so they win at equal specificity", async () => {
    const rules = parseRules(await emit("prose", "prose-ink")).filter((r) => r.resolved.includes(".prose-ink"))
    const at = (el: string) => rules.findIndex((r) => new RegExp(`:where\\(${el}\\)`).test(r.resolved))
    const strong = at("strong")
    expect(strong).toBeGreaterThan(-1)
    for (const el of ["h1 strong", "h2 strong", "h3 strong, h4 strong"]) {
      expect(at(el), el).toBeGreaterThan(strong)
    }
  })

  it("AC-14c: the reading call sites set heading weight with an !important variant — prose-ink's (0,2,0) rules outrank a plain prose-headings: variant", async () => {
    for (const file of ["components/materials/material-article.tsx", "components/stories/story-article.tsx"]) {
      const src = readFileSync(join(root, file), "utf-8")
      expect(src, file).toContain("prose-ink")
      expect(src, file).toMatch(/\bprose-headings:font-semibold!(?=[\s"])/)
      expect(src, file).not.toMatch(/\bprose-headings:font-semibold(?=[\s"])/)
    }
    const variant = parseRules(await emit("prose-headings:font-semibold!"))
      .map((r) => r.decls)
      .join(" ")
    expect(variant).toContain("--type-w: 600 !important;")
    expect(variant).toContain("font-weight: calc(600 * var(--type-wa, 1) + var(--type-wb, 0)) !important;")
  })

  it("AC-15: primitives carry their role class in their className strings", () => {
    const read = (f: string) => readFileSync(join(root, "components/ui", f), "utf-8")
    /** Source of a forwardRef / arrow component, from its declaration to its displayName. */
    const component = (src: string, name: string) => {
      const at = src.indexOf(`const ${name} =`)
      const end = src.indexOf(`${name}.displayName`, at)
      return at === -1 || end === -1 ? "" : src.slice(at, end)
    }

    const heading: Array<[string, string]> = [
      ["card.tsx", "CardTitle"],
      ["dialog.tsx", "DialogTitle"],
      ["alert-dialog.tsx", "AlertDialogTitle"],
      ["sheet.tsx", "SheetTitle"],
    ]
    for (const [file, name] of heading) {
      expect(component(read(file), name), name).toMatch(/className=[^>]*\btype-heading\b/)
    }

    const tag: Array<[string, string]> = [
      ["select.tsx", "SelectLabel"],
      ["dropdown-menu.tsx", "DropdownMenuLabel"],
      ["dropdown-menu.tsx", "DropdownMenuShortcut"],
    ]
    for (const [file, name] of tag) {
      expect(component(read(file), name), name).toMatch(/className=[^>]*\btype-tag\b/)
    }

    // Badge: the cva base string (first argument).
    const badgeBase = read("badge.tsx").match(/cva\(\s*"([^"]*)"/)?.[1] ?? ""
    expect(badgeBase).toMatch(/\btype-tag\b/)

    // FilterChip: the chip's label classes live on the button's className.
    const chip = read("filter-chip.tsx")
    const fn = chip.slice(chip.indexOf("export function FilterChip"))
    const buttonClasses = fn.match(/<button[\s\S]*?className=\{cn\(\s*"([^"]*)"/)?.[1] ?? ""
    expect(buttonClasses).toMatch(/\btype-tag\b/)
  })

  it("EC-1: tracking-normal stays letter-spacing 0em (a zero is not scaled)", async () => {
    const body = declsOf(parseRules(await emit("tracking-normal")), (r) => r.selector === ".tracking-normal")
    expect(body).toContain("letter-spacing: 0em;")
  })

  it("EC-2: every --f-*-features and every --type-features declaration is non-empty", () => {
    const all = parseRules(baseCss).map((r) => r.decls).join(" ")
    const fFeatures = [...all.matchAll(/(--f-[\w-]+-features):\s*([^;]*);/g)]
    // Positive control: the generated token file must be in the output, or this passes vacuously.
    expect(fFeatures.map((m) => m[1])).toContain("--f-inter-text-features")
    for (const [, name, value] of fFeatures) {
      expect(value.trim(), name).not.toBe("")
    }
    const typeFeatures = [...all.matchAll(/--type-features:\s*([^;]*);/g)].map((m) => m[1].trim())
    expect(typeFeatures.length).toBeGreaterThanOrEqual(4)
    expect(typeFeatures.filter((v) => v === "")).toEqual([])
  })
})
