import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"

/**
 * RAD-388 — `truncate` clips sideways only, so a tall accent or a descender is
 * not cut at the line box (IBM Plex Sans lost 1.4px of an accent on a 24px
 * `h1.truncate`). Pinned on the CSS Tailwind EMITS, because the override is
 * two same-name utilities that only work in the order Tailwind sorts them:
 *
 *   - `overflow: clip visible` must land AFTER the core `overflow: hidden`, yet
 *     before `overflow-hidden` / `overflow-visible`, which still win;
 *   - `min-width: 0` must land BEFORE `min-w-*`, which still wins. It keeps the
 *     flex/grid automatic minimum at 0: a clip box is not a scroll container,
 *     so without it every `flex-1 truncate` would grow to its full text width.
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

/** Top-level rules of the utilities layer, in source order. */
function utilityRules(css: string): { selector: string; body: string }[] {
  const start = css.indexOf("@layer utilities {")
  expect(start, "utilities layer").toBeGreaterThan(-1)
  const out: { selector: string; body: string }[] = []
  let i = css.indexOf("{", start) + 1
  for (;;) {
    const open = css.indexOf("{", i)
    const close = css.indexOf("}", i)
    if (open === -1 || close < open) return out // end of the layer
    let depth = 0
    let end = open
    for (; end < css.length; end++) {
      if (css[end] === "{") depth++
      if (css[end] === "}" && --depth === 0) break
    }
    out.push({ selector: css.slice(i, open).trim(), body: css.slice(open + 1, end) })
    i = end + 1
  }
}

/** The declarations `classes` end up with: later rules win, `overflow` expands to its longhands. */
function cascade(css: string, ...classes: string[]): Record<string, string> {
  const selectors = new Set(classes.map((c) => "." + c.replace(/:/g, "\\:")))
  const out: Record<string, string> = {}
  for (const { selector, body } of utilityRules(css)) {
    if (!selectors.has(selector)) continue
    for (const m of body.matchAll(/([a-z-]+):\s*([^;{}]+);/g)) {
      const [prop, value] = [m[1], m[2].trim()]
      if (prop === "overflow") {
        const [x, y = x] = value.split(/\s+/)
        out["overflow-x"] = x
        out["overflow-y"] = y
      } else {
        out[prop] = value
      }
    }
  }
  return out
}

describe("truncate clips the inline axis only (RAD-388)", () => {
  it("clips sideways, leaves the block axis visible and still draws the ellipsis", async () => {
    const css = await emit("truncate")
    expect(cascade(css, "truncate")).toMatchObject({
      "overflow-x": "clip",
      "overflow-y": "visible",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
      "min-width": "0",
    })
  })

  it("keeps a flex or grid item shrinkable, as overflow: hidden did", async () => {
    const css = await emit("truncate")
    expect(cascade(css, "truncate")["min-width"]).toBe("0")
  })

  it("lets an explicit min-w-* on the same element win", async () => {
    const css = await emit("truncate", "min-w-24")
    expect(cascade(css, "truncate", "min-w-24")["min-width"]).toBe("calc(var(--spacing) * 24)")
  })

  it("lets an explicit overflow utility on the same element win", async () => {
    const css = await emit("truncate", "overflow-hidden", "overflow-x-auto")
    expect(cascade(css, "truncate", "overflow-hidden")).toMatchObject({ "overflow-x": "hidden", "overflow-y": "hidden" })
    expect(cascade(css, "truncate", "overflow-x-auto")["overflow-x"]).toBe("auto")
  })

  it("carries the same override to a variant", async () => {
    const css = await emit("md:truncate")
    const bodies = utilityRules(css)
      .filter((r) => r.selector === ".md\\:truncate")
      .map((r) => r.body.replace(/\s+/g, " "))
    const overflow = bodies.map((b) => b.match(/overflow: ([^;]+);/)?.[1]).filter(Boolean)
    expect(overflow.at(-1)).toBe("clip visible")
    expect(bodies.some((b) => /min-width: 0;/.test(b))).toBe(true)
  })
})
