import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Guards the `prefers-reduced-motion` collapse in app/globals.css.
 *
 * Collapsing only the DURATION is a half-fix that looks complete: with
 * `animation-duration: 0.01ms` nothing visibly moves, so a screenshot and a
 * click-through both pass — while a staggered entrance still reveals its cards
 * one at a time across the delay ladder (measured 2026-09-11 on the posts grid:
 * 9 running `fadeInScale` animations, each sitting out its `Math.min(index *
 * 50, 500)` delay). Sequential appearance IS motion, and it is exactly what the
 * setting asks to remove.
 *
 * Both halves below are load-bearing. The declaration must exist, and it must
 * be `!important` — the `.delay-*` ladder and the `.animate-*` classes sit in
 * `@layer utilities`, a later layer than the guard's `@layer base`, and the
 * stagger itself is applied inline (`style={{ animationDelay }}` in
 * components/materials/animated-grid.tsx and components/stories/stories-list.tsx).
 * A normal declaration loses to both; an author `!important` beats both.
 *
 * This is a source-shape assertion — it cannot prove the cascade actually
 * resolves that way in an engine. A real-engine check in Chromium and WebKit
 * (owner-only harness, not part of this repository) measures the real thing.
 */
const root = resolve(__dirname, "..")
// Comments come out FIRST: a brace inside one would otherwise terminate the
// block early and collapse every assertion below with an unrelated message.
const css = readFileSync(join(root, "app/globals.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "")

/** The guard's FIRST rule — its selector and its declarations, separately. */
function readGuard() {
  const open = css.indexOf("@media (prefers-reduced-motion: reduce)")
  expect(open, "app/globals.css must carry a reduced-motion guard").toBeGreaterThan(-1)
  const selStart = css.indexOf("{", open) + 1
  const selEnd = css.indexOf("{", selStart)
  const bodyEnd = css.indexOf("}", selEnd)
  return {
    selector: css.slice(selStart, selEnd).replace(/\s+/g, " ").trim(),
    // Scoped to this one rule on purpose: reading the whole media block would
    // accept a collapse hidden in some `.one-component` rule beside it, which
    // is the regression the universality test below exists to catch.
    body: css.slice(selEnd + 1, bodyEnd),
  }
}

describe("prefers-reduced-motion guard", () => {
  it("collapses delays, not just durations", () => {
    const { body } = readGuard()
    for (const prop of [
      "animation-duration",
      "animation-delay",
      "transition-duration",
      "transition-delay",
    ]) {
      // No trailing `;` required — it is optional on the last declaration.
      const decl = body.match(new RegExp(`(?:^|[\\s;])${prop}\\s*:([^;}]+)`))
      expect(decl, `the guard must collapse ${prop}`).not.toBeNull()
      const value = decl![1].trim()
      const time = value.match(/(-?[\d.]+)(ms|s)?\b/)
      expect(time, `${prop} must carry a time value`).not.toBeNull()
      // Keep the sign: a delay may be negative (the animation starts already
      // finished, so no base state paints), a duration may not be zero or less.
      const ms = Number(time![1]) * (time![2] === "s" ? 1000 : 1)
      expect(ms, `${prop} must collapse to ~0`).toBeLessThanOrEqual(1)
      if (prop.endsWith("duration")) {
        expect(ms, `${prop} must stay positive`).toBeGreaterThan(0)
      }
      expect(value, `${prop} must win over the utilities layer and the inline stagger`).toContain(
        "!important",
      )
    }
  })

  it("applies universally, so an inline stagger on any component is reached", () => {
    // A scoped selector would silently miss whichever component is added next.
    expect(readGuard().selector).toBe("*, *::before, *::after")
  })
})
