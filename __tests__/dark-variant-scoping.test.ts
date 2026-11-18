/**
 * `dark:` follows the `.dark` class, not the OS scheme (RAD-362).
 *
 * Tailwind v4 reads CSS, not tailwind.config.ts — `darkMode: "class"` in the
 * JS config was never loaded — so every `dark:` utility compiled to
 * `@media (prefers-color-scheme: dark)` while next-themes flips `.dark` on
 * <html>. Measured on the reading surfaces on an OS/app theme mismatch:
 * prose headings, bold and code painted white on a white card (~1.1:1).
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"

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

describe("dark: — class-scoped, not media-scoped (RAD-362)", () => {
  it("control: a non-variant utility carries no dark scoping", async () => {
    // The palette's own `.dark { … }` block is always emitted, so the control
    // pins the variant MARKER (:where(.dark, .dark *)) — the thing only a
    // dark: utility can add — not the substring ".dark".
    const css = flat(await emit("text-primary"))
    expect(css).not.toContain(":where(.dark, .dark *)")
    expect(css).not.toContain("prefers-color-scheme")
  })

  it("a dark: utility compiles to the .dark class", async () => {
    const css = flat(await emit("dark:text-primary"))
    expect(css).toContain(":where(.dark, .dark *)")
    expect(css).not.toContain("prefers-color-scheme")
  })

  it("the prose reading palette rides the same class", async () => {
    const css = flat(await emit("dark:prose-invert"))
    expect(css).toContain(":where(.dark, .dark *)")
    expect(css).not.toContain("prefers-color-scheme")
  })
})
