/**
 * Typography adaptation (RAD-363) — turns the measured metrics in
 * `font-metrics.json` into the numbers CSS needs, so every face renders at
 * the reference face's optical size, with caps centred in the line box, at a
 * matched stroke weight and with tabular figures where it has them.
 *
 * Pure and client-safe; every function is keyed by FACE id (not font id) and
 * throws on an unknown one. Spec: .tdd/spec-typography-core.md.
 */

import metrics from "./font-metrics.json"

export interface VerticalOverrides {
  ascent: number
  descent: number
  lineGap: number
}

export interface WeightMap {
  a: number
  b: number
}

interface FaceFile {
  path: string
  unicodeRange: string
  weight?: number
}

interface FaceMetrics {
  axes: Record<string, number[]>
  hhea: { ascent: number; descent: number }
  capHeight: number
  xHeight: number
  xHeightOS2: number
  figureHeight: number
  digitAdvances: number[]
  tabularDigitAdvance: number | null
  features: string[]
  stems: number[][]
  files?: FaceFile[]
  static?: boolean
  system?: string
}

const FACES = metrics.faces as unknown as Record<string, FaceMetrics>

const DAMPING = 0.75
const IDENTITY_SNAP = 10
const CAPS_THRESHOLD = 0.01
const LOGICAL_WEIGHTS = [400, 500, 600, 700]

const round4 = (v: number) => Math.round(v * 10000) / 10000

function face(id: string): FaceMetrics {
  if (!Object.hasOwn(FACES, id)) throw new Error(`Unknown typography face: ${id}`)
  return FACES[id]
}

const reference = () => face(metrics.reference)

/** The x-height `font-size-adjust` reads: OS/2 for system faces, measured for shipped ones. */
const effectiveXHeight = (f: FaceMetrics) => (f.system ? f.xHeightOS2 : f.xHeight)

/** Unrounded normalisation factor n = reference x-height ÷ face x-height. */
const normalise = (f: FaceMetrics) => effectiveXHeight(reference()) / effectiveXHeight(f)

/** Linear interpolation of y at x over ascending [x, y] points, clamped to the ends. */
function interpolate(points: number[][], x: number): number {
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
  }
  return points[points.length - 1][1]
}

export function sizeAdjust(id: string): number {
  return round4(normalise(face(id)))
}

export function verticalOverrides(id: string): VerticalOverrides {
  const f = face(id)
  const { hhea } = reference()
  const lineBox = (hhea.ascent + hhea.descent) / sizeAdjust(id)
  return {
    ascent: round4((lineBox + f.capHeight) / 2),
    descent: round4((lineBox - f.capHeight) / 2),
    lineGap: 0,
  }
}

export function weightMap(id: string): WeightMap {
  const f = face(id)
  // A static face has one file per weight: only the identity lands the logical
  // 400/500/600/700 on their own files under the browser's font matching.
  if (f.static) return { a: 1, b: 0 }
  const refStems = reference().stems
  const inverse = f.stems.map(([w, ratio]) => [ratio, w])
  const targets = LOGICAL_WEIGHTS.map((N) => {
    const matched = interpolate(inverse, interpolate(refStems, N))
    return N + DAMPING * (matched - N)
  })
  if (targets.every((t, i) => Math.abs(t - LOGICAL_WEIGHTS[i]) <= IDENTITY_SNAP)) {
    return { a: 1, b: 0 }
  }
  const count = LOGICAL_WEIGHTS.length
  const meanN = LOGICAL_WEIGHTS.reduce((s, N) => s + N, 0) / count
  const meanT = targets.reduce((s, t) => s + t, 0) / count
  let cov = 0
  let variance = 0
  LOGICAL_WEIGHTS.forEach((N, i) => {
    cov += (N - meanN) * (targets[i] - meanT)
    variance += (N - meanN) ** 2
  })
  const a = cov / variance
  return { a: round4(a), b: round4(meanT - a * meanN) }
}

export function resolveWeight(id: string, weight: number): number {
  const f = face(id)
  const [min, , max] = f.axes.wght
  const { a, b } = weightMap(id)
  const resolved = Math.min(max, Math.max(min, Math.round(a * weight + b)))
  if (!f.static) return resolved
  // A static face has no interpolation: clamp, then take the nearest shipped file.
  const shipped = (f.files ?? []).map((file) => file.weight).filter((w): w is number => w !== undefined)
  return shipped.reduce((best, w) => (Math.abs(w - resolved) < Math.abs(best - resolved) ? w : best), shipped[0])
}

export function capsScale(id: string): number {
  const f = face(id)
  return (f.capHeight * normalise(f)) / reference().capHeight
}

export function figureScale(id: string): number {
  const f = face(id)
  return (f.figureHeight * normalise(f)) / reference().figureHeight
}

export function needsCapsAdjust(id: string): boolean {
  return Math.abs(capsScale(id) - 1) > CAPS_THRESHOLD || Math.abs(figureScale(id) - 1) > CAPS_THRESHOLD
}

/** The single digit advance of a face whose ten digits are equally wide, else null. */
function commonDigitAdvance(f: FaceMetrics): number | null {
  const [first] = f.digitAdvances
  return f.digitAdvances.every((d) => d === first) ? first : null
}

export function tabularFigures(id: string): "native" | "none" {
  const f = face(id)
  return f.features.includes("tnum") || commonDigitAdvance(f) !== null ? "native" : "none"
}

export function tabularAdvance(id: string): number {
  const f = face(id)
  const advance = f.tabularDigitAdvance ?? commonDigitAdvance(f)
  if (advance === null) throw new Error(`Typography face has no tabular figures: ${id}`)
  return advance * normalise(f)
}
