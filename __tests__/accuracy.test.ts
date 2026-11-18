/**
 * computeAccuracyMetrics — TDD RED tests (RAD-111)
 *
 * Verifies accuracy tracking metrics computation as a pure function.
 * Spec criteria covered: AC-1, AC-2, AC-3, AC-4, AC-5, EC-1, EC-2, ERR-1
 */

import { describe, it, expect } from "vitest"
import { computeAccuracyMetrics } from "@/lib/accuracy"

// ---------------------------------------------------------------------------
// AC-1: Perfect agreement — AI approved 8 (all used), AI filtered 2 (all left)
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — AC-1: perfect agreement", () => {
  it("AC-1: returns 100% agreement rate when user fully agrees with AI decisions", () => {
    const materials = [
      // AI approved 8 — user uses all 8 (4 SENT_TO_NOTION, 4 SENT_TO_STORIES)
      ...Array.from({ length: 4 }, (_, i) => ({
        aiEvaluation: "APPROVED",
        userStatus: "SENT_TO_NOTION",
        sourceId: "src-a",
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        aiEvaluation: "APPROVED",
        userStatus: "SENT_TO_STORIES",
        sourceId: "src-a",
      })),
      // AI filtered 2 — user left both as ARCHIVED
      ...Array.from({ length: 2 }, (_, i) => ({
        aiEvaluation: "FILTERED",
        userStatus: "ARCHIVED",
        sourceId: "src-a",
      })),
    ]

    const result = computeAccuracyMetrics(materials)

    expect(result.totalDecisions).toBe(10)
    expect(result.agreements).toBe(10)
    expect(result.overrides).toBe(0)
    expect(result.agreementRate).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// AC-2: Mixed decisions — 5 materials, 3 agreements, 2 overrides, 60% rate
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — AC-2: mixed decisions", () => {
  it("AC-2: counts agreements and overrides correctly with mixed outcomes", () => {
    const materials = [
      // AI approved 3
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-b" },  // agreement
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-b" },  // agreement
      { aiEvaluation: "APPROVED", userStatus: "ARCHIVED", sourceId: "src-b" },        // EXCLUDED (ambiguous)
      // AI filtered 2
      { aiEvaluation: "FILTERED", userStatus: "SENT_TO_NOTION", sourceId: "src-b" },  // override (false negative)
      { aiEvaluation: "FILTERED", userStatus: "ARCHIVED", sourceId: "src-b" },        // agreement
    ]

    const result = computeAccuracyMetrics(materials)

    // APPROVED+ARCHIVED is excluded, so 4 decisions not 5
    expect(result.totalDecisions).toBe(4)
    expect(result.agreements).toBe(3)
    expect(result.overrides).toBe(1)
    expect(result.agreementRate).toBe(75)
  })
})

// ---------------------------------------------------------------------------
// AC-3: falsePositives — AI approved but user rejected
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — AC-3: false positives", () => {
  it("AC-3: counts falsePositives only when AI APPROVED and user DELETED (not ARCHIVED)", () => {
    const materials = [
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-c" },  // agreement
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-c" },  // agreement
      { aiEvaluation: "APPROVED", userStatus: "ARCHIVED", sourceId: "src-c" },        // EXCLUDED (ambiguous)
      { aiEvaluation: "APPROVED", userStatus: "DELETED", sourceId: "src-c" },         // false positive
      { aiEvaluation: "FILTERED", userStatus: "SENT_TO_NOTION", sourceId: "src-c" },  // false negative
      { aiEvaluation: "FILTERED", userStatus: "ARCHIVED", sourceId: "src-c" },        // agreement
    ]

    const result = computeAccuracyMetrics(materials)

    expect(result.falsePositives).toBe(1)
    expect(result.totalDecisions).toBe(5) // 6 - 1 excluded ARCHIVED
  })
})

// ---------------------------------------------------------------------------
// AC-4: falseNegatives — AI filtered but user used the content
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — AC-4: false negatives", () => {
  it("AC-4: counts falseNegatives as AI FILTERED but user status is SENT_TO_NOTION or SENT_TO_STORIES", () => {
    const materials = [
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-d" },  // agreement
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-d" },  // agreement
      { aiEvaluation: "APPROVED", userStatus: "ARCHIVED", sourceId: "src-d" },        // EXCLUDED
      { aiEvaluation: "FILTERED", userStatus: "SENT_TO_NOTION", sourceId: "src-d" },  // false negative
      { aiEvaluation: "FILTERED", userStatus: "ARCHIVED", sourceId: "src-d" },        // agreement
    ]

    const result = computeAccuracyMetrics(materials)

    expect(result.falseNegatives).toBe(1)
    expect(result.totalDecisions).toBe(4) // 5 - 1 excluded
  })
})

// ---------------------------------------------------------------------------
// AC-5: perSource — metrics computed independently per sourceId
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — AC-5: perSource breakdown", () => {
  it("AC-5: returns independent metrics per sourceId in perSource record", () => {
    const materials = [
      // source-1: perfect agreement (2 approved + used, 1 filtered + archived)
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "source-1" },
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_STORIES", sourceId: "source-1" },
      { aiEvaluation: "FILTERED", userStatus: "ARCHIVED", sourceId: "source-1" },
      // source-2: one override (approved + deleted), one excluded (approved + archived)
      { aiEvaluation: "APPROVED", userStatus: "DELETED", sourceId: "source-2" },
      { aiEvaluation: "APPROVED", userStatus: "ARCHIVED", sourceId: "source-2" },  // excluded
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "source-2" },
    ]

    const result = computeAccuracyMetrics(materials)

    expect(result.perSource["source-1"]).toBeDefined()
    expect(result.perSource["source-1"].totalDecisions).toBe(3)
    expect(result.perSource["source-1"].agreements).toBe(3)
    expect(result.perSource["source-1"].overrides).toBe(0)
    expect(result.perSource["source-1"].agreementRate).toBe(100)

    expect(result.perSource["source-2"]).toBeDefined()
    expect(result.perSource["source-2"].totalDecisions).toBe(2) // 3 - 1 excluded
    expect(result.perSource["source-2"].agreements).toBe(1)
    expect(result.perSource["source-2"].overrides).toBe(1)
    expect(result.perSource["source-2"].agreementRate).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// EC-1: Empty input
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — EC-1: empty input", () => {
  it("EC-1: returns all-zero metrics with empty perSource for an empty array", () => {
    const result = computeAccuracyMetrics([])

    expect(result).toEqual({
      totalDecisions: 0,
      agreements: 0,
      overrides: 0,
      falsePositives: 0,
      falseNegatives: 0,
      agreementRate: 0,
      perSource: {},
    })
  })
})

// ---------------------------------------------------------------------------
// EC-2: Materials with userStatus NEW or READ are excluded
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — EC-2: pending user statuses excluded", () => {
  it("EC-2: materials with userStatus NEW or READ are excluded from all metrics", () => {
    const materials = [
      { aiEvaluation: "APPROVED", userStatus: "NEW", sourceId: "src-e" },
      { aiEvaluation: "APPROVED", userStatus: "READ", sourceId: "src-e" },
      { aiEvaluation: "FILTERED", userStatus: "NEW", sourceId: "src-e" },
      // Only this one counts
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-e" },
    ]

    const result = computeAccuracyMetrics(materials)

    expect(result.totalDecisions).toBe(1)
    expect(result.agreements).toBe(1)
    expect(result.overrides).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ERR-1: Unknown aiEvaluation values are excluded
// ---------------------------------------------------------------------------
describe("computeAccuracyMetrics — ERR-1: unknown aiEvaluation excluded", () => {
  it("ERR-1: materials with unknown aiEvaluation values are excluded from computation", () => {
    const materials = [
      { aiEvaluation: "PENDING", userStatus: "SENT_TO_NOTION", sourceId: "src-f" },
      { aiEvaluation: "UNKNOWN", userStatus: "ARCHIVED", sourceId: "src-f" },
      { aiEvaluation: "", userStatus: "SENT_TO_STORIES", sourceId: "src-f" },
      // Only this one is valid
      { aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION", sourceId: "src-f" },
    ]

    const result = computeAccuracyMetrics(materials)

    expect(result.totalDecisions).toBe(1)
    expect(result.agreements).toBe(1)
  })
})
