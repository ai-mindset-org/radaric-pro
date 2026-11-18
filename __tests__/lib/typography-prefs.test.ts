/**
 * RAD-363 typography preferences (cycle B1) — lenient DB parser, strict PATCH
 * validator, presets, the per-user runtime CSS, and own-property hardening of
 * the cycle-A registry lookups. Spec: .tdd/spec-typography-prefs.md.
 * Pure modules: inputs -> outputs, no mocks.
 */

import { describe, it, expect } from "vitest"

import { isFontId, isRole, fontStack, FONT_IDS, ROLES } from "@/lib/typography/fonts"
import { sizeAdjust, verticalOverrides, weightMap, resolveWeight } from "@/lib/typography/derive"
import {
  DEFAULT_TYPOGRAPHY,
  parseTypographyPrefs,
  validateTypographyInput,
  type TypographyPrefs,
} from "@/lib/typography/prefs"
import { PRESETS, matchPreset } from "@/lib/typography/presets"
import { ROLE_TOKENS, buildTypographyCss } from "@/lib/typography/css"

const ALL_INTER = { heading: "inter", text: "inter", counter: "inter", tag: "inter" }

/** The literal token list from AC-9 — kept independent of ROLE_TOKENS so AC-11/12 are not circular. */
const SPEC_TOKENS = [
  "family",
  "stretch",
  "wa",
  "wb",
  "size-adjust",
  "caps-adjust",
  "features",
  "df",
  "cf",
  "leading",
]

const remap = (role: string, fontId: string) =>
  SPEC_TOKENS.map((t) => `--type-${role}-${t}:var(--f-${fontId}-${role}-${t})`)

const EC3_PATTERN =
  /^(:root\{--type-(heading|text|counter|tag)-[a-z-]+:var\(--f-[a-z-]+-(heading|text|counter|tag)-[a-z-]+\)(;--type-(heading|text|counter|tag)-[a-z-]+:var\(--f-[a-z-]+-(heading|text|counter|tag)-[a-z-]+\))*\})?$/

describe("typography prefs (RAD-363 cycle B1)", () => {
  it("AC-1: isFontId accepts exactly the registry ids and isRole exactly the roles", () => {
    expect(FONT_IDS.map((id) => isFontId(id))).toEqual([true, true, true, true, true, true, true, true, true, true, true])
    const notFonts: unknown[] = ["comic-sans", "constructor", "toString", "__proto__", "", 42, null, undefined]
    expect(notFonts.map((v) => isFontId(v))).toEqual(notFonts.map(() => false))

    expect(ROLES.map((r) => isRole(r))).toEqual([true, true, true, true])
    const notRoles: unknown[] = ["hasOwnProperty", "body", 1]
    expect(notRoles.map((v) => isRole(v))).toEqual([false, false, false])
  })

  it("AC-2: DEFAULT_TYPOGRAPHY is all-Inter and frozen", () => {
    expect(DEFAULT_TYPOGRAPHY).toEqual(ALL_INTER)
    expect(Object.isFrozen(DEFAULT_TYPOGRAPHY)).toBe(true)
  })

  it("AC-3: parseTypographyPrefs returns a valid full object as an equal fresh copy", () => {
    const input = { heading: "martian-grotesk", text: "pt-root-ui", counter: "martian-mono", tag: "sf-pro" }
    const parsed = parseTypographyPrefs(input)
    expect(parsed).toEqual({
      heading: "martian-grotesk",
      text: "pt-root-ui",
      counter: "martian-mono",
      tag: "sf-pro",
    })
    expect(parsed).not.toBe(input)
  })

  it("AC-4: parseTypographyPrefs falls back role by role and drops unknown keys", () => {
    expect(parseTypographyPrefs({ heading: "martian-mono", text: "comic-sans", counter: 7 })).toEqual({
      heading: "martian-mono",
      text: "inter",
      counter: "inter",
      tag: "inter",
    })
    expect(parseTypographyPrefs({ heading: "sf-mono", colour: "red" })).toEqual({
      heading: "sf-mono",
      text: "inter",
      counter: "inter",
      tag: "inter",
    })
  })

  it("AC-5: validateTypographyInput accepts null and a full valid object", () => {
    expect(validateTypographyInput(null)).toEqual({ ok: true, value: null })
    const input = { heading: "martian-grotesk", text: "inter", counter: "sf-mono", tag: "pt-root-ui" }
    const result = validateTypographyInput(input)
    expect(result).toEqual({
      ok: true,
      value: { heading: "martian-grotesk", text: "inter", counter: "sf-mono", tag: "pt-root-ui" },
    })
    if (result.ok) expect(result.value).not.toBe(input)
  })

  it("AC-6: validateTypographyInput refuses everything that is not the exact four-role object", () => {
    const full = { heading: "inter", text: "inter", counter: "inter", tag: "inter" }
    const bad: unknown[] = [
      undefined,
      "inter",
      42,
      [],
      ["inter", "inter", "inter", "inter"],
      { heading: "inter", text: "inter", counter: "inter" },
      { ...full, extra: "inter" },
      { ...full, text: "comic-sans" },
      { ...full, counter: 1 },
      { ...full, tag: null },
    ]
    const summary = bad.map((raw) => {
      const r = validateTypographyInput(raw)
      return r.ok === false && typeof r.error === "string" && r.error.length > 0 ? "refused" : r
    })
    expect(summary).toEqual(bad.map(() => "refused"))
  })

  it("AC-7: PRESETS are the five presets in order, each a valid prefs object", () => {
    expect(PRESETS).toEqual([
      { id: "inter", label: "Inter", prefs: ALL_INTER },
      {
        id: "martian",
        label: "Martian",
        prefs: { heading: "martian-grotesk", text: "martian-grotesk", counter: "martian-mono", tag: "martian-grotesk" },
      },
      {
        id: "apple",
        label: "Apple",
        prefs: { heading: "sf-pro", text: "sf-pro", counter: "sf-mono", tag: "sf-pro" },
      },
      {
        id: "pt-root",
        label: "PT Root",
        prefs: { heading: "pt-root-ui", text: "pt-root-ui", counter: "martian-mono", tag: "pt-root-ui" },
      },
      {
        id: "plex",
        label: "Plex",
        prefs: { heading: "ibm-plex-sans", text: "ibm-plex-sans", counter: "ibm-plex-mono", tag: "ibm-plex-sans" },
      },
    ])
    expect(PRESETS.map((p) => validateTypographyInput(p.prefs).ok)).toEqual([true, true, true, true, true])
  })

  it("AC-8: matchPreset names the preset a prefs object equals, else null", () => {
    expect(matchPreset(DEFAULT_TYPOGRAPHY)).toBe("inter")
    expect(PRESETS.map((p) => matchPreset({ ...p.prefs }))).toEqual(["inter", "martian", "apple", "pt-root", "plex"])
    expect(
      matchPreset({ heading: "martian-grotesk", text: "martian-grotesk", counter: "martian-mono", tag: "inter" }),
    ).toBe(null)
  })

  it("AC-9: ROLE_TOKENS is the ten per-role tokens in order", () => {
    expect(ROLE_TOKENS).toEqual([
      "family",
      "stretch",
      "wa",
      "wb",
      "size-adjust",
      "caps-adjust",
      "features",
      "df",
      "cf",
      "leading",
    ])
  })

  it("AC-10: the default preference produces no CSS", () => {
    expect(buildTypographyCss(DEFAULT_TYPOGRAPHY)).toBe("")
  })

  it("AC-11: one changed role remaps its ten tokens inside one :root rule", () => {
    const css = buildTypographyCss({ heading: "martian-grotesk", text: "inter", counter: "inter", tag: "inter" })
    expect(css).toBe(":root{" + remap("heading", "martian-grotesk").join(";") + "}")
  })

  it("AC-12: two changed roles emit text then counter, nothing for unchanged roles", () => {
    const css = buildTypographyCss({ heading: "inter", text: "pt-root-ui", counter: "sf-mono", tag: "inter" })
    expect(css).toBe(":root{" + [...remap("text", "pt-root-ui"), ...remap("counter", "sf-mono")].join(";") + "}")
  })

  it("EC-1: non-object input parses to a fresh default copy that does not alias DEFAULT_TYPOGRAPHY", () => {
    const inputs: unknown[] = [null, undefined, "inter", 42, [], ["martian-mono"], new Date()]
    const parsed = inputs.map((raw) => parseTypographyPrefs(raw))
    expect(parsed).toEqual(inputs.map(() => ALL_INTER))
    expect(parsed.map((p) => p === DEFAULT_TYPOGRAPHY)).toEqual(inputs.map(() => false))

    const copy = parseTypographyPrefs(null)
    copy.heading = "sf-mono"
    expect(DEFAULT_TYPOGRAPHY).toEqual(ALL_INTER)
  })

  it("EC-2: prototype-shaped and inherited values never pass", () => {
    expect(parseTypographyPrefs({ heading: "constructor", text: "__proto__", counter: "toString" })).toEqual(ALL_INTER)
    expect(parseTypographyPrefs(Object.create({ heading: "martian-mono" })).heading).toBe("inter")
    const poisoned = JSON.parse('{"__proto__":{"x":1},"heading":"inter","text":"inter","counter":"inter","tag":"inter"}')
    expect(validateTypographyInput(poisoned).ok).toBe(false)
  })

  it("EC-3: buildTypographyCss parses its input, so hostile values never reach the stylesheet", () => {
    const hostile = {
      heading: "</style><script>alert(1)</script>",
      text: 5,
      counter: "sf-mono",
      tag: {},
    } as unknown as TypographyPrefs
    const css = buildTypographyCss(hostile)
    expect(css).toBe(":root{" + remap("counter", "sf-mono").join(";") + "}")

    const outputs = [css, ...PRESETS.map((p) => buildTypographyCss(p.prefs))]
    const inner = (s: string) => (s === "" ? "" : s.slice(":root{".length, -1))
    expect(outputs.map((s) => /[<>{}]/.test(inner(s)))).toEqual(outputs.map(() => false))
    expect(outputs.map((s) => EC3_PATTERN.test(s))).toEqual(outputs.map(() => true))
    // guard against a vacuous pass: the non-default presets must actually emit CSS
    expect(outputs.map((s) => s.startsWith(":root{"))).toEqual([true, false, true, true, true, true])
  })

  it("ERR-1: registry and face lookups throw on prototype-shaped ids, naming the id", () => {
    expect(() => fontStack("constructor", "text")).toThrow("constructor")
    expect(() => fontStack("__proto__", "text")).toThrow("__proto__")
    expect(() => fontStack("toString", "heading")).toThrow("toString")
    expect(() => sizeAdjust("constructor")).toThrow("constructor")
    expect(() => verticalOverrides("toString")).toThrow("toString")
    expect(() => weightMap("__proto__")).toThrow("__proto__")
    expect(() => resolveWeight("hasOwnProperty", 400)).toThrow("hasOwnProperty")
  })
})
