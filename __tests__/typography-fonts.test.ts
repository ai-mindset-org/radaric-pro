/**
 * RAD-363 slice 3 — how the self-hosted fonts reach the page.
 *
 * next/font needs literal arguments, so app/fonts/inter.ts spells out each
 * subset's `unicode-range`. These guards pin those literals to the cmap that
 * scripts/typography/measure-fonts.py recorded, and pin the root layout's
 * wiring (variables on <html>, fonts.css before globals.css, no Google font).
 * The built CSS itself was checked once by hand after `next build`; the
 * rendered-metrics gate lives in an owner-only harness, not part of this
 * repository.
 */
import { readFileSync, existsSync } from "fs"
import path from "path"
import { describe, it, expect } from "vitest"
import metrics from "@/lib/typography/font-metrics.json"

const ROOT = path.resolve(__dirname, "..")
const INTER = readFileSync(path.join(ROOT, "app/fonts/inter.ts"), "utf8")
const LAYOUT = readFileSync(path.join(ROOT, "app/layout.tsx"), "utf8")

interface LocalFontCall {
  name: string
  body: string
}

function localFontCalls(source: string): LocalFontCall[] {
  const calls: LocalFontCall[] = []
  const re = /export const (\w+) = localFont\(\{([\s\S]*?)\n\}\)/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    calls.push({ name: m[1], body: m[2] })
  }
  return calls
}

function field(body: string, key: string): string | undefined {
  return body.match(new RegExp(`\\b${key}: ("[^"]*"|true|false)`))?.[1]
}

function declaration(body: string, prop: string): string | undefined {
  return body.match(new RegExp(`\\{ prop: "${prop}", value: "([^"]*)" \\}`))?.[1]
}

const interFiles = metrics.faces.inter.files
const calls = localFontCalls(INTER)

describe("Inter loading (app/fonts/inter.ts)", () => {
  it("declares one next/font/local call per Inter subset file", () => {
    const srcs = calls.map((c) => field(c.body, "src"))
    expect(srcs.sort()).toEqual(
      interFiles.map((f) => `"./${path.relative("app/fonts", f.path)}"`).sort(),
    )
    for (const f of interFiles) expect(existsSync(path.join(ROOT, f.path)), f.path).toBe(true)
  })

  it("gives every call its file's recorded cmap as unicode-range", () => {
    for (const f of interFiles) {
      const call = calls.find((c) => field(c.body, "src") === `"./${path.relative("app/fonts", f.path)}"`)
      expect(call, f.path).toBeDefined()
      expect(declaration(call!.body, "unicode-range"), f.path).toBe(f.unicodeRange)
    }
  })

  it("names one family across the three calls, so the subsets compose into one face", () => {
    expect(calls.map((c) => declaration(c.body, "font-family"))).toEqual(
      calls.map(() => "interLatin"),
    )
    expect(calls.map((c) => c.name)).toContain("interLatin")
  })

  it("preloads and metric-matches only the latin file, which owns --font-inter", () => {
    const latin = calls.find((c) => c.name === "interLatin")!
    expect([field(latin.body, "preload"), field(latin.body, "adjustFontFallback"), field(latin.body, "variable")]).toEqual([
      "true",
      '"Arial"',
      '"--font-inter"',
    ])
    for (const c of calls.filter((c) => c.name !== "interLatin")) {
      expect([c.name, field(c.body, "preload"), field(c.body, "adjustFontFallback")]).toEqual([c.name, "false", "false"])
      expect(field(c.body, "variable"), c.name).not.toBe('"--font-inter"')
    }
  })

  it("keeps both variable axes' weight range", () => {
    for (const c of calls) expect([c.name, field(c.body, "weight")]).toEqual([c.name, '"100 900"'])
  })
})

describe("root layout wiring (app/layout.tsx)", () => {
  it("imports fonts.css before globals.css", () => {
    const fontsAt = LAYOUT.indexOf('import "./fonts/fonts.css"')
    const globalsAt = LAYOUT.indexOf('import "./globals.css"')
    expect(fontsAt).toBeGreaterThan(-1)
    expect(globalsAt).toBeGreaterThan(fontsAt)
  })

  it("puts every Inter variable on <html>, so :root tokens can resolve --font-inter", () => {
    const html = LAYOUT.match(/<html[\s\S]*?>/)?.[0] ?? ""
    for (const name of calls.map((c) => c.name)) expect(html, name).toContain(`${name}.variable`)
  })

  it("leaves font-family to the role rules: no font-sans on <body>", () => {
    const body = LAYOUT.match(/<body[^>]*>/)?.[0] ?? ""
    expect(body).not.toMatch(/\bfont-sans\b/)
  })

  it("no longer loads Inter from Google", () => {
    expect(LAYOUT).not.toContain("next/font/google")
  })
})
