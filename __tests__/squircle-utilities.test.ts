import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"

/**
 * The superellipse on every rounded rectangle, on every engine — pinned on the
 * CSS Tailwind actually EMITS for a class, not on the text of globals.css.
 *
 * WebKit renders no `corner-shape`, so every button, input, chip, badge and
 * menu on an iPhone was a plain arc (2026-09-13: the arcs were visible on the posts
 * toolbar). The shape is a mask there, and a mask must land on exactly the
 * element the rounded utility targets. Matching `[class*="rounded-"]` does not
 * do that: `prose-img:rounded-lg` sits on the article, `focus:rounded-md` on a
 * skip link that is square until focused, `sm:rounded-2xl` on a dialog that is
 * full-bleed on a phone. So both branches live inside the `rounded-*`
 * utilities, and every variant carries them to its own element.
 *
 * Every assertion here is invisible in Chrome, which is where the diff gets
 * reviewed.
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

/** The value Tailwind's built-in rule gives `property` for `selector`. */
function builtIn(css: string, selector: string, property: string): string {
  for (const body of rulesFor(css, selector)) {
    const m = flat(body).match(new RegExp(`^ ${property}: ([^;]+); $`))
    if (m) return m[1]
  }
  throw new Error(`no built-in ${property} for ${selector}`)
}

/** The rule that carries the corner variables — the extension, not the built-in. */
function extension(css: string, selector: string): string {
  const body = rulesFor(css, selector).find((b) => b.includes("--sq-"))
  expect(body, `${selector} must carry the corner variables`).toBeDefined()
  return flat(body ?? "")
}

describe("rounded utilities carry the superellipse", () => {
  it("sets all four corner radii to the rung on the shorthand", async () => {
    const css = await emit("rounded-sm")
    const radius = builtIn(css, ".rounded-sm", "border-radius")
    const body = extension(css, ".rounded-sm")
    for (const corner of ["tl", "tr", "br", "bl"]) {
      expect(body, `--sq-${corner}-r`).toContain(`--sq-${corner}-r: ${radius};`)
    }
  })

  it("sets only its own two corners on a directional rung, and still shapes them", async () => {
    const css = await emit("rounded-t-sm")
    const body = extension(css, ".rounded-t-sm")
    expect(body).toMatch(/--sq-tl-r: [^;]+;/)
    expect(body).toMatch(/--sq-tr-r: [^;]+;/)
    expect(body).not.toMatch(/--sq-b[lr]-r:/)
    expect(body).toContain("mask-composite: subtract")
  })

  it("sorts the shorthand before a directional, the way border-radius sorts", async () => {
    // `rounded-sm rounded-t-xl` draws xl on top. If the corner variables sorted
    // the other way the mask would cut an 8px notch into an 18px arc.
    const css = await emit("rounded-t-xl", "rounded-sm")
    const shorthand = css.indexOf(".rounded-sm {")
    const directional = css.indexOf(".rounded-t-xl {")
    expect(shorthand).toBeGreaterThan(-1)
    expect(directional).toBeGreaterThan(shorthand)
  })

  it("zeros every corner on rounded-none, so a breakpoint that squares an element also unmasks it", async () => {
    const body = extension(await emit("rounded-none"), ".rounded-none")
    for (const corner of ["tl", "tr", "br", "bl"]) {
      expect(body).toMatch(new RegExp(`--sq-${corner}-r: 0(px)?;`))
    }
  })

  it("shapes the bare `rounded` too, at Tailwind's own radius", async () => {
    // Bare `rounded` is 0.25rem, not the project's --radius (14px): a 14px notch
    // in a 24px button overlaps itself into a blob.
    const css = await emit("rounded")
    const radius = builtIn(css, ".rounded", "border-radius")
    const body = extension(css, ".rounded")
    expect(body).toContain("mask-composite: subtract")
    for (const corner of ["tl", "tr", "br", "bl"]) {
      expect(body).toContain(`--sq-${corner}-r: ${radius};`)
    }
  })

  it("uses corner-shape where the engine has it and a mask where it does not", async () => {
    const body = extension(await emit("rounded-md"), ".rounded-md")
    expect(body).toContain("@supports (corner-shape: superellipse(2))")
    expect(body).toContain("corner-shape: superellipse(var(--corner-k))")
    expect(body).toContain("@supports not (corner-shape: superellipse(2))")
    expect(body).toContain("border-radius: 0;")
    expect(body).toContain("-webkit-mask-composite: source-out, source-over, source-over, source-over, source-over;")
    expect(body).toContain("mask-composite: subtract, add, add, add, add;")
    // The fill layer follows the element; only corners carry a length.
    expect(body).toContain(
      "mask-size: 100% 100%, var(--sq-tl-r) var(--sq-tl-r), var(--sq-tr-r) var(--sq-tr-r), var(--sq-br-r) var(--sq-br-r), var(--sq-bl-r) var(--sq-bl-r);",
    )
    // The opt-out.
    expect(body).toMatch(/:not\([^{]*\.corner-round/)
  })

  it("never shapes a capsule", async () => {
    const css = await emit("rounded-full")
    for (const body of rulesFor(css, ".rounded-full")) {
      expect(body).not.toContain("mask")
      expect(body).not.toContain("corner-shape")
    }
  })

  it("does not mask what a mask would clip: shadows, borders, blur, scrollers, native fields, drawn surfaces", async () => {
    const body = extension(await emit("rounded-lg"), ".rounded-lg")
    const not = body.match(/@supports not \(corner-shape: superellipse\(2\)\) \{ &:not\(([^{]*)\) \{/)?.[1] ?? ""
    for (const excluded of [
      '[class*="shadow-"]:not([data-slot="button"])',
      '[class~="border"]',
      '[class*="backdrop-blur"]',
      '[class*="overflow-y-auto"]',
      "input",
      "textarea",
      ".surface-card",
      ".elevation-card",
      ".icon-tile",
      ".surface-mask",
      ":has(",
      "select, video",
    ]) {
      expect(not, excluded).toContain(excluded)
    }
  })

  it("lands a variant's shape on the element the variant targets", async () => {
    const prose = flat(await emit("prose-img:rounded-lg"))
    const proseRule = prose.slice(prose.indexOf(".prose-img\\:rounded-lg {"))
    expect(proseRule).toMatch(/^\.prose-img\\:rounded-lg \{ & :is\(:where\(img\)[^{]*\{ --sq-tl-r:/)

    const responsive = flat(await emit("sm:rounded-2xl"))
    expect(responsive).toMatch(/\.sm\\:rounded-2xl \{ @media [^{]*\{ --sq-tl-r:/)
  })

  it("paints the ring on a pseudo-element that inherits the host's ring colour", async () => {
    // Tailwind registers --tw-ring-color with `inherits: false`, so a pseudo
    // reading it without `inherit` sees nothing and the ring paints blank.
    const css = flat(await emit("rounded-sm"))
    const at = css.indexOf(':where([class*="rounded"]:is(')
    expect(at, "the flat ring rule").toBeGreaterThan(-1)
    const after = css.slice(at, css.indexOf("}", at))
    expect(after).toContain("--tw-ring-color: inherit;")
    expect(after).toContain("background: var(--tw-ring-color, var(--ring));")
    expect(after).toContain("mask-composite: add, add, add, add, subtract, add;")
    expect(after).toContain("-webkit-mask-composite: source-over, source-over, source-over, source-over, source-out, source-over;")
    // ...and only where the ring state is on. A bare `[class*="rounded"]::after`
    // would hand this paint to a library's own `::after` — Sonner's
    // expanded-toast gap strip (content-only) used to come out as green
    // crescents at the toast's top corners.
    expect(after, "the ring state guard").toContain('[class~="ring-1"]')
    expect(css).not.toContain(':where([class*="rounded"])::after')
    // The utility only switches it on.
    const body = extension(await emit("rounded-sm"), ".rounded-sm")
    expect(body).toMatch(/::after \{ content: ""; \}/)
  })

  it("declares the ring's paint once, not in every rung and variant", async () => {
    // Copied into each utility, the ring tripled the stylesheet (146 → 433 KB
    // minified across the rungs in use).
    const body = extension(await emit("rounded-sm"), ".rounded-sm")
    expect(body).not.toContain("--tw-ring-color")
    expect(body).not.toContain("--sq-ring-w: ")
    expect(body).not.toContain("mask-origin")
  })

  it("makes a bare `rounded` ring host a containing block, so its ring lands on it", async () => {
    const css = flat(await emit("rounded"))
    expect(css).toMatch(/:where\(:is\(\[class\*="rounded-"\], \[class~="rounded"\]\):is\(\[class\*="ring-"\][^{]*\{ position: relative; \}/)
  })

  it("suppresses the box-shadow ring the mask would cut, and leaves the drop shadow alone", async () => {
    const body = extension(await emit("rounded-sm"), ".rounded-sm")
    expect(body).toContain("--tw-ring-shadow: 0 0 #0000 !important;")
    expect(body).toContain("--tw-inset-ring-shadow: 0 0 #0000 !important;")
    expect(body).not.toMatch(/--tw-shadow:/)
  })
})
