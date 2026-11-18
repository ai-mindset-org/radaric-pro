/**
 * RAD-363 typography core (cycle A) — font registry + adaptation formulas.
 * Spec: .tdd/spec-typography-core.md. Pure modules: tested inputs -> outputs,
 * no mocks. The measured data (lib/typography/font-metrics.json) is real; the
 * test reads it only to iterate faces and compute the spec's invariants.
 */

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import path from "path"

import metrics from "@/lib/typography/font-metrics.json"
import { FONT_IDS, ROLES, FONTS, FIGURES_FACE, fontStack } from "@/lib/typography/fonts"
import {
  sizeAdjust,
  verticalOverrides,
  weightMap,
  resolveWeight,
  capsScale,
  figureScale,
  needsCapsAdjust,
  tabularFigures,
  tabularAdvance,
} from "@/lib/typography/derive"

type Face = {
  axes: Record<string, number[]>
  capHeight: number
  figureHeight: number
  xHeight: number
  xHeightOS2: number
  digitAdvances: number[]
  files?: { path: string; sha256: string; unicodeRange: string; weight?: number }[]
  static?: boolean
  system?: string
}

const FACES = (metrics as unknown as { faces: Record<string, Face> }).faces
const FACE_IDS = Object.keys(FACES)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..")
const LOGICAL = [400, 500, 600, 700] as const

/** The x-height `font-size-adjust` reads: OS/2 for system faces, measured for shipped ones. */
const effectiveX = (id: string) => (FACES[id].system ? FACES[id].xHeightOS2 : FACES[id].xHeight)
const n = (id: string) => FACES.inter.xHeight / effectiveX(id)

const within = (actual: number, expected: number, tol: number) => {
  expect(Math.abs(actual - expected), `${actual} vs ${expected} (±${tol})`).toBeLessThanOrEqual(tol)
}

const stackParts = (stack: string) => stack.split(",").map((s) => s.trim())

const EXPECTED_FONT_IDS = [
  "inter",
  "martian-grotesk",
  "pt-root-ui",
  "golos-text",
  "ibm-plex-sans",
  "sf-pro",
  "sf-pro-rounded",
  "martian-mono",
  "jetbrains-mono",
  "ibm-plex-mono",
  "sf-mono",
]
const EXPECTED_ROLES = ["heading", "text", "counter", "tag"]

describe("typography registry (lib/typography/fonts)", () => {
  it("AC-1: FONT_IDS is the eleven fonts in picker order and ROLES the four roles", () => {
    expect([...FONT_IDS]).toEqual(EXPECTED_FONT_IDS)
    expect([...ROLES]).toEqual(EXPECTED_ROLES)
  })

  it("AC-2: every font's standard and narrow faces exist in font-metrics.json; only the Martians have distinct narrow faces", () => {
    expect(Object.keys(FONTS).sort()).toEqual([...EXPECTED_FONT_IDS].sort())
    for (const id of EXPECTED_FONT_IDS) {
      const { standard, narrow } = FONTS[id].faces
      expect(FACE_IDS, `${id}.standard`).toContain(standard)
      expect(FACE_IDS, `${id}.narrow`).toContain(narrow)
    }
    expect(FONTS["martian-grotesk"].faces.narrow).toBe("martian-grotesk-narrow")
    expect(FONTS["martian-mono"].faces.narrow).toBe("martian-mono-narrow")
    for (const id of EXPECTED_FONT_IDS.filter((f) => !f.startsWith("martian-"))) {
      expect(FONTS[id].faces.narrow, id).toBe(FONTS[id].faces.standard)
    }
    // IBM Plex Sans measures 0.4933 lowercase-en at wdth 100 — under Inter's
    // 0.5163, so it needs no narrow cut for tags.
    expect(FONTS["ibm-plex-sans"].faces.standard).toBe("ibm-plex-sans")
  })

  it("AC-3: group, source and availability metadata per font", () => {
    const byField = (field: "group" | "source" | "availability") =>
      Object.fromEntries(EXPECTED_FONT_IDS.map((id) => [id, FONTS[id]?.[field]]))

    expect(byField("group")).toEqual({
      inter: "sans",
      "martian-grotesk": "sans",
      "pt-root-ui": "sans",
      "golos-text": "sans",
      "ibm-plex-sans": "sans",
      "sf-pro": "sans",
      "sf-pro-rounded": "sans",
      "martian-mono": "mono",
      "jetbrains-mono": "mono",
      "ibm-plex-mono": "mono",
      "sf-mono": "mono",
    })
    expect(byField("source")).toEqual({
      inter: "self-hosted",
      "martian-grotesk": "self-hosted",
      "pt-root-ui": "self-hosted",
      "golos-text": "self-hosted",
      "ibm-plex-sans": "self-hosted",
      "sf-pro": "system",
      "sf-pro-rounded": "system",
      "martian-mono": "self-hosted",
      "jetbrains-mono": "self-hosted",
      "ibm-plex-mono": "self-hosted",
      "sf-mono": "system",
    })
    expect(byField("availability")).toEqual({
      inter: "everywhere",
      "martian-grotesk": "everywhere",
      "pt-root-ui": "everywhere",
      "golos-text": "everywhere",
      "ibm-plex-sans": "everywhere",
      "sf-pro": "apple",
      "sf-pro-rounded": "apple-safari",
      "martian-mono": "everywhere",
      "jetbrains-mono": "everywhere",
      "ibm-plex-mono": "everywhere",
      "sf-mono": "apple",
    })
  })

  it("AC-4: inter stacks start with var(--font-inter); sans stacks fall back to Inter then sans-serif; mono stacks end with monospace", () => {
    for (const role of EXPECTED_ROLES) {
      expect(stackParts(fontStack("inter", role))[0], `inter/${role}`).toBe("var(--font-inter)")
    }
    const sansOthers = ["martian-grotesk", "pt-root-ui", "golos-text", "ibm-plex-sans", "sf-pro", "sf-pro-rounded"]
    for (const id of sansOthers) {
      for (const role of EXPECTED_ROLES) {
        const parts = stackParts(fontStack(id, role))
        const interAt = parts.indexOf("var(--font-inter)")
        expect(interAt, `${id}/${role} has Inter after its own family`).toBeGreaterThan(0)
        expect(parts[parts.length - 1], `${id}/${role}`).toBe("sans-serif")
      }
    }
    for (const id of ["martian-mono", "jetbrains-mono", "ibm-plex-mono", "sf-mono"]) {
      for (const role of EXPECTED_ROLES) {
        const parts = stackParts(fontStack(id, role))
        expect(parts[parts.length - 1], `${id}/${role}`).toBe("monospace")
      }
    }
  })

  it("AC-5: Martian Grotesk counters lead with the Figures family; other roles lead with the grotesk; figures come from martian-mono-narrow", () => {
    const counter = stackParts(fontStack("martian-grotesk", "counter"))
    expect(counter[0]).toBe('"Radaric Martian Grotesk Figures"')
    expect(counter[1]).toBe('"Radaric Martian Grotesk"')
    for (const role of ["heading", "text", "tag"]) {
      expect(stackParts(fontStack("martian-grotesk", role))[0], role).toBe('"Radaric Martian Grotesk"')
    }
    expect(FIGURES_FACE["martian-grotesk"]).toBe("martian-mono-narrow")
  })
})

describe("typography adaptation (lib/typography/derive)", () => {
  it("AC-6: sizeAdjust normalises every face to Inter's x-height", () => {
    expect(sizeAdjust("inter")).toBe(1)
    expect(sizeAdjust("martian-grotesk")).toBe(0.9098)
    expect(sizeAdjust("pt-root-ui")).toBe(1.0918)
    expect(sizeAdjust("golos-text")).toBe(1.03)
    expect(sizeAdjust("ibm-plex-sans")).toBe(1.0579)
    expect(sizeAdjust("jetbrains-mono")).toBe(0.9925)
    expect(sizeAdjust("ibm-plex-mono")).toBe(1.0579)
    for (const id of FACE_IDS) {
      const s = sizeAdjust(id)
      expect(s, `${id} rounded to 4 decimals`).toBe(Math.round(s * 10000) / 10000)
      within(effectiveX(id) * s, 0.5459, 0.0005)
    }
  })

  it("AC-7: verticalOverrides for inter, martian-grotesk and pt-root-ui match the measured ratios", () => {
    const cases: [string, number, number][] = [
      ["inter", 0.9688, 0.2412],
      ["martian-grotesk", 1.065, 0.265],
      ["pt-root-ui", 0.9041, 0.2041],
    ]
    for (const [id, ascent, descent] of cases) {
      const v = verticalOverrides(id)
      within(v.ascent, ascent, 0.0006)
      within(v.descent, descent, 0.0006)
      expect(v.lineGap, id).toBe(0)
    }
  })

  it("AC-8: for every face the scaled line box is Inter's 1.21 em and the cap band is centred", () => {
    for (const id of FACE_IDS) {
      const s = sizeAdjust(id)
      const { ascent, descent, lineGap } = verticalOverrides(id)
      within((ascent + descent) * s, 1.21, 0.001)
      within((ascent - descent) * s, FACES[id].capHeight * s, 0.001)
      expect(lineGap, id).toBe(0)
    }
  })

  it("AC-9: weightMap is the identity for inter, sf-pro, sf-pro-rounded and the static ibm-plex-mono", () => {
    for (const id of ["inter", "sf-pro", "sf-pro-rounded", "ibm-plex-mono"]) {
      expect(weightMap(id), id).toEqual({ a: 1, b: 0 })
    }
  })

  it("AC-10: resolveWeight matches the stem-matched targets; pt-root-ui 700 clamps to the axis max", () => {
    const expected: Record<string, number[]> = {
      "martian-grotesk": [323, 457, 590, 724],
      "martian-mono": [323, 457, 590, 724],
      "sf-mono": [409, 517, 625, 733],
      "pt-root-ui": [458, 548, 637, 700],
      "golos-text": [400, 484, 572, 659],
      "ibm-plex-sans": [403, 491, 578, 666],
      "jetbrains-mono": [375, 494, 613, 731],
    }
    for (const [id, targets] of Object.entries(expected)) {
      LOGICAL.forEach((N, i) => within(resolveWeight(id, N), targets[i], 6))
    }
    expect(resolveWeight("pt-root-ui", 700)).toBe(700)
  })

  it("AC-10b: a static face clamps to its axis and snaps to the nearest shipped weight", () => {
    LOGICAL.forEach((N) => expect(resolveWeight("ibm-plex-mono", N), String(N)).toBe(N))
    expect(resolveWeight("ibm-plex-mono", 800)).toBe(700)
    expect(resolveWeight("ibm-plex-mono", 100)).toBe(400)
    expect(resolveWeight("ibm-plex-mono", 620)).toBe(600)
  })

  it("AC-11: for every face resolved weights at 400..700 rise strictly, each step >= 60", () => {
    for (const id of FACE_IDS) {
      const w = LOGICAL.map((N) => resolveWeight(id, N))
      for (let i = 1; i < w.length; i++) {
        expect(w[i] - w[i - 1], `${id} ${LOGICAL[i - 1]}->${LOGICAL[i]} (${w.join("/")})`).toBeGreaterThanOrEqual(60)
      }
    }
  })

  it("AC-12: capsScale/figureScale are the n-scaled cap and figure heights over Inter's; needsCapsAdjust flags a >1% deviation (pt-root-ui, sf-pro-rounded, both IBM Plex faces)", () => {
    // Formula definitions, for every measured face.
    for (const id of FACE_IDS) {
      const caps = FACES[id].capHeight * n(id) / FACES.inter.capHeight
      const figs = FACES[id].figureHeight * n(id) / FACES.inter.figureHeight
      within(capsScale(id), caps, 0.0005)
      within(figureScale(id), figs, 0.0005)
      expect(needsCapsAdjust(id), id).toBe(Math.abs(caps - 1) > 0.01 || Math.abs(figs - 1) > 0.01)
    }

    within(capsScale("martian-grotesk"), 1, 0.005)
    within(figureScale("martian-grotesk"), 1, 0.01)
    within(capsScale("pt-root-ui"), 1.0506, 0.005)

    const standards = EXPECTED_FONT_IDS.map((id) => FONTS[id].faces.standard)
    const flagged = standards.filter((face) => needsCapsAdjust(face)).sort()
    expect(flagged).toEqual(["ibm-plex-mono", "ibm-plex-sans", "pt-root-ui", "sf-pro-rounded"])
  })

  it("AC-13: tabularFigures is native for tnum or equal-advance faces and none for martian-grotesk", () => {
    expect(tabularFigures("martian-grotesk")).toBe("none")
    for (const id of ["inter", "martian-mono", "sf-mono", "pt-root-ui", "golos-text", "ibm-plex-sans", "jetbrains-mono", "ibm-plex-mono"]) {
      expect(tabularFigures(id), id).toBe("native")
    }
  })

  it("AC-14: tabularAdvance scales the tabular digit width; the narrow-mono figures sit within 5% of the grotesk's mean digit", () => {
    within(tabularAdvance("inter"), 0.6484 * n("inter"), 0.0005)
    within(tabularAdvance("pt-root-ui"), 0.59 * n("pt-root-ui"), 0.0005)
    within(tabularAdvance("martian-mono"), 0.7 * n("martian-mono"), 0.0005)
    within(tabularAdvance("sf-mono"), 0.6182 * n("sf-mono"), 0.0005)
    within(tabularAdvance("golos-text"), 0.62 * n("golos-text"), 0.0005)

    const g = FACES["martian-grotesk"].digitAdvances
    const groteskMean = (g.reduce((a, b) => a + b, 0) / g.length) * n("martian-grotesk")
    const figures = tabularAdvance("martian-mono-narrow")
    expect(Math.abs(figures - groteskMean) / groteskMean).toBeLessThanOrEqual(0.05)
    within(figures, 0.65 * n("martian-mono-narrow"), 0.0005)
  })

  it("EC-1: resolveWeight extrapolates outside 400-700 and clamps to the wght axis", () => {
    expect(resolveWeight("pt-root-ui", 900)).toBe(700)
    expect(resolveWeight("pt-root-ui", 100)).toBe(300)
    expect(resolveWeight("inter", 300)).toBe(300)
  })

  it("EC-2: every shipped font file reachable from the registry exists and matches its recorded sha256", () => {
    // Every face the registry references (standard, narrow, figures) must cover
    // every measured face, so no measured file escapes the integrity check.
    const referenced = new Set<string>([
      ...Object.values(FONTS).flatMap((f) => [f.faces.standard, f.faces.narrow]),
      ...Object.values(FIGURES_FACE),
    ])
    expect([...referenced].sort()).toEqual([...FACE_IDS].sort())

    const files = new Map<string, string>()
    for (const face of referenced) {
      for (const f of FACES[face].files ?? []) files.set(f.path, f.sha256)
    }
    expect(files.size).toBe(18)
    for (const [rel, sha] of files) {
      const abs = path.join(PROJECT_ROOT, rel)
      expect(existsSync(abs), rel).toBe(true)
      expect(createHash("sha256").update(readFileSync(abs)).digest("hex"), rel).toBe(sha)
    }
  })

  it("EC-3: the static face carries one weighted file per shipped weight and no wght interpolation", () => {
    const face = FACES["ibm-plex-mono"]
    expect(face.static).toBe(true)
    expect(face.axes.wght).toEqual([400, 400, 700])
    expect((face.files ?? []).map((f) => f.weight)).toEqual([400, 500, 600, 700])
    for (const id of FACE_IDS.filter((f) => !FACES[f].static)) {
      expect(FACES[id].static, id).toBeUndefined()
    }
  })

  it("ERR-1: every derive function throws an Error naming an unknown face id", () => {
    const calls: [string, () => unknown][] = [
      ["sizeAdjust", () => sizeAdjust("comic-sans")],
      ["verticalOverrides", () => verticalOverrides("comic-sans")],
      ["weightMap", () => weightMap("comic-sans")],
      ["resolveWeight", () => resolveWeight("comic-sans", 400)],
      ["capsScale", () => capsScale("comic-sans")],
      ["figureScale", () => figureScale("comic-sans")],
      ["needsCapsAdjust", () => needsCapsAdjust("comic-sans")],
      ["tabularFigures", () => tabularFigures("comic-sans")],
      ["tabularAdvance", () => tabularAdvance("comic-sans")],
    ]
    for (const [name, call] of calls) {
      expect(call, name).toThrowError(/comic-sans/)
    }
  })
})
