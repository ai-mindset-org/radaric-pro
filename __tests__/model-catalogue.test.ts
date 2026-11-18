/**
 * Model catalogue guard.
 *
 * Every model id the app can select must exist at its provider and, where the
 * code calls generateObject on it, support structured outputs. Five ids failed
 * that on 2026-09-08 and had been failing silently for months:
 *
 *   google/gemini-2.0-flash-001       retired 2026-06-01 (hardcoded in feed-extraction)
 *   google/gemini-2.0-flash-lite-001  retired 2026-06-01
 *   claude-sonnet-4-20250514          not served on this account
 *   claude-haiku-3-5-20241022         not served on this account
 *   google/gemini-2.5-flash           shuts down 2026-10-16 — still live, so an
 *                                     existence check would NOT have caught it
 *
 * This test is deliberately HERMETIC — it reads checked-in snapshots and never
 * touches the network. A CI job that runs it on push and auto-reverts a commit
 * when a test fails would otherwise revert unrelated, correct commits over an
 * OpenRouter 5xx or a rate limit. The live probe that refreshes these snapshots
 * belongs in a scheduled job, not here.
 */

import { describe, it, expect } from "vitest"
import {
  ANTHROPIC_MODELS,
  OPENROUTER_MODELS,
  STAGE_DEFAULTS,
  isOpenRouterModel,
} from "@/lib/models/registry"
import openrouterCatalogue from "./fixtures/openrouter-catalogue.json"
import anthropicCatalogue from "./fixtures/anthropic-catalogue.json"

/** Snapshots older than this are stale enough that the guard means nothing. */
const MAX_SNAPSHOT_AGE_DAYS = 90

/**
 * Announced shutdown dates for models the app can still select. An id stays
 * selectable until it is actually gone, so existence alone is a lagging
 * indicator — this map is what turns the guard into a leading one.
 * Add a row whenever a provider announces a retirement.
 */
const KNOWN_EOL: Record<string, string> = {
  "google/gemini-2.5-flash": "2026-10-16",
  "google/gemini-2.5-flash-lite": "2026-10-16",
}
const EOL_WARNING_WINDOW_DAYS = 60

const orIds = new Map(openrouterCatalogue.models.map((m) => [m.id, m]))
const anthropicIds = new Set(anthropicCatalogue.models.map((m) => m.id))

/** Every id the app can reach, and whether generateObject is called on it. */
const ALL_SELECTABLE = [
  ...ANTHROPIC_MODELS.map((m) => m.id),
  ...OPENROUTER_MODELS.map((m) => m.id),
]
/**
 * Every stage default, keyed by stage. Derived from STAGE_DEFAULTS rather than
 * listed here, so a stage added to the registry is covered without a second edit
 * — the previous hand-listed set is exactly how the extraction model went three
 * months unguarded.
 */
const DEFAULTS: Record<string, string> = { ...STAGE_DEFAULTS }

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

describe("catalogue snapshots", () => {
  it("are recent enough to be meaningful", () => {
    for (const snap of [openrouterCatalogue, anthropicCatalogue]) {
      const age = daysBetween(new Date(snap.fetchedAt), new Date())
      expect(
        age,
        `${snap.source} snapshot is ${age} days old — refresh it (npm run catalogue:refresh)`
      ).toBeLessThanOrEqual(MAX_SNAPSHOT_AGE_DAYS)
    }
  })
})

describe("every selectable model exists at its provider", () => {
  it.each(ALL_SELECTABLE)("%s", (id) => {
    if (isOpenRouterModel(id)) {
      expect(orIds.has(id), `${id} is not in the OpenRouter catalogue`).toBe(true)
    } else {
      expect(anthropicIds.has(id), `${id} is not served by the Anthropic API`).toBe(true)
    }
  })
})

describe("every default model exists at its provider", () => {
  it.each(Object.entries(DEFAULTS))("%s = %s", (_name, id) => {
    if (isOpenRouterModel(id)) {
      expect(orIds.has(id), `${id} is not in the OpenRouter catalogue`).toBe(true)
    } else {
      expect(anthropicIds.has(id), `${id} is not served by the Anthropic API`).toBe(true)
    }
  })

  it("defaults a user can override are selectable, so they can always get back", () => {
    // Only these stages have a settings column today. `extraction`, `synthesis`
    // and `discovery` are not user-configurable, so they have no dropdown to
    // appear in — their ids are still checked for existence above.
    const CONFIGURABLE_STAGES = ["filtering", "storyWriter", "storyMatcher", "materialStory"] as const

    for (const stage of CONFIGURABLE_STAGES) {
      const id = STAGE_DEFAULTS[stage]
      expect(ALL_SELECTABLE, `${stage} default ${id} is not selectable`).toContain(id)
    }
  })
})

describe("models used with generateObject support structured outputs", () => {
  // Filtering, story writing and the material pipeline all call generateObject.
  // An OpenRouter model without structured_outputs fails at runtime, not at build.
  const openrouterSelectable = ALL_SELECTABLE.filter(isOpenRouterModel)

  it.each(openrouterSelectable)("%s", (id) => {
    const entry = orIds.get(id)
    expect(entry, `${id} missing from snapshot`).toBeDefined()
    expect(
      entry!.structured_outputs,
      `${id} does not advertise structured_outputs — generateObject will fail on it`
    ).toBe(true)
  })
})

describe("announced end-of-life", () => {
  it("no in-use model is within the EOL warning window", () => {
    const inUse = new Set([...ALL_SELECTABLE, ...Object.values(DEFAULTS)])
    const now = new Date()
    const failures: string[] = []

    for (const [id, eolDate] of Object.entries(KNOWN_EOL)) {
      if (!inUse.has(id)) continue
      const daysLeft = daysBetween(now, new Date(eolDate))
      if (daysLeft <= EOL_WARNING_WINDOW_DAYS) {
        failures.push(`${id} shuts down ${eolDate} (${daysLeft} days) — migrate it`)
      }
    }

    expect(failures, failures.join("\n")).toEqual([])
  })

  it("no DEFAULT_* constant points at a model with an announced shutdown", () => {
    for (const [name, id] of Object.entries(DEFAULTS)) {
      expect(KNOWN_EOL[id], `${name} = ${id}, which is scheduled for shutdown`).toBeUndefined()
    }
  })
})
