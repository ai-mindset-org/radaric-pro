import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

/**
 * Guards the single-import-path rule for NumberFlow (RAD-355).
 *
 * `components/ui/morph-number.tsx` is the only module allowed to import the
 * library, because that wrapper is where the environment guard lives:
 * `@number-flow/react` reads `matchMedia(...).matches` during render, so it does
 * not merely degrade outside a browser — it throws, and jsdom mounts this
 * component in every card test. A second importer silently re-opens that class
 * of crash, and no other test would see it.
 *
 * Source-shape assertion, in the style of `torph-import-hygiene.test.ts`: it
 * cannot run the library, but `vitest run` is in the release gate and this is
 * the only thing that fails if the boundary is crossed.
 */

const root = resolve(__dirname, "..")
const SOURCE_DIRS = ["app", "components", "lib", "scripts", "__tests__"]
const ROOT_FILES = ["proxy.ts", "instrumentation.ts"]
const SKIPPED = new Set(["node_modules", ".next", "coverage", "test-results", "fixtures"])
const WRAPPER = join("components", "ui", "morph-number.tsx")
const IMPORT_RE = /(?:from\s*|require\(\s*|import\(\s*)["']@number-flow\/[^"']*["']/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED.has(entry.name)) continue
      // A nested checkout (a private sibling repo) is a different product, not
      // this source tree: its `.git` entry is the marker.
      if (existsSync(join(full, ".git"))) continue
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe("NumberFlow import hygiene", () => {
  it("keeps every @number-flow import inside the wrapper", () => {
    const importers = [...SOURCE_DIRS.flatMap(dir => sourceFiles(join(root, dir))), ...ROOT_FILES.map(f => join(root, f))]
      .filter(file => IMPORT_RE.test(readFileSync(file, "utf-8")))
      .map(file => relative(root, file))

    expect(importers).toContain(WRAPPER)
    expect(importers.filter(file => file !== WRAPPER)).toEqual([])
  })
})
