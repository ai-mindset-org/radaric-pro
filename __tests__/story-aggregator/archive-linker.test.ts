/**
 * Archive Linker tests — TDD RED phase
 *
 * These tests import from lib/story-aggregator/archive-linker.ts.
 *
 * Spec reference: the Story Aggregator specification section 4.5 (Archive Search)
 *
 * Exports under test:
 *   ArchiveLink interface
 *   ArchiveRawResult interface
 *   ArchiveLinkerDeps interface (DI)
 *   SIMILARITY_THRESHOLD constant (= 0.3)
 *   MAX_RELATED_MATERIALS constant (= 5)
 *   findRelatedMaterials(storyTitle, storySummary, deps) => Promise<ArchiveLink[]>
 */

import { describe, it, expect, vi } from "vitest"
import {
  findRelatedMaterials,
  SIMILARITY_THRESHOLD,
  MAX_RELATED_MATERIALS,
  type ArchiveLink,
  type ArchiveLinkerDeps,
  type ArchiveRawResult,
} from "@/lib/story-aggregator/archive-linker"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_EMBEDDING: number[] = Array.from({ length: 1536 }, (_, i) => i * 0.001)

const STORY_TITLE = "Anthropic releases Claude 5 with new reasoning capabilities"
const STORY_SUMMARY = "Anthropic unveiled Claude 5, featuring enhanced multimodal reasoning."

/** A raw result from the archive DB that passes the 0.3 threshold */
const mockRawResultAboveThreshold: ArchiveRawResult = {
  title: "Anthropic Claude 4 Release",
  url: "https://archive.example.com/issues/500/claude-4",
  description: "Previous release of the Claude model family.",
  issueNumber: 500,
  rubrics: ["Инструмент"],
  similarity: 0.72,
}

/** A raw result from the archive DB that is exactly at threshold — should be excluded (strictly > 0.3) */
const mockRawResultAtThreshold: ArchiveRawResult = {
  title: "AI Tools Overview",
  url: "https://archive.example.com/issues/490/ai-tools",
  description: "Overview of AI tools for designers.",
  issueNumber: 490,
  rubrics: ["Инструмент"],
  similarity: 0.3,
}

/** A raw result from the archive DB that falls below the 0.3 threshold */
const mockRawResultBelowThreshold: ArchiveRawResult = {
  title: "Unrelated design history article",
  url: "https://archive.example.com/issues/400/design-history",
  description: "A deep dive into Bauhaus design principles.",
  issueNumber: 400,
  rubrics: ["Istoriya dizayna"],
  similarity: 0.15,
}

/** A raw result with no issueNumber (null) — tests nullable field mapping */
const mockRawResultNoIssueNumber: ArchiveRawResult = {
  title: "Figma Plugins Round-up",
  url: "https://archive.example.com/materials/figma-round-up",
  description: "Popular Figma plugins for interface designers.",
  issueNumber: null,
  rubrics: ["Plaginy Figma"],
  similarity: 0.55,
}

// ---------------------------------------------------------------------------
// Factory: build a fully-mocked ArchiveLinkerDeps object
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<ArchiveLinkerDeps> = {}): ArchiveLinkerDeps {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(MOCK_EMBEDDING),
    queryMaterials: vi.fn().mockResolvedValue([mockRawResultAboveThreshold]),
    ...overrides,
  }
}

// ===========================================================================
// 1. Exported constants
// ===========================================================================

describe("exported constants (spec 4.5)", () => {
  it("SIMILARITY_THRESHOLD equals 0.3", () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.3)
  })

  it("MAX_RELATED_MATERIALS equals 5", () => {
    expect(MAX_RELATED_MATERIALS).toBe(5)
  })
})

// ===========================================================================
// 2. findRelatedMaterials — happy path
// ===========================================================================

describe("findRelatedMaterials — happy path (spec 4.5)", () => {
  it("returns an ArchiveLink[] with mapped fields for results above threshold", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: returns an array with one entry (the above-threshold result)
    expect(result).toHaveLength(1)
    const link: ArchiveLink = result[0]
    expect(link.title).toBe(mockRawResultAboveThreshold.title)
    expect(link.url).toBe(mockRawResultAboveThreshold.url)
    expect(link.issueNumber).toBe(mockRawResultAboveThreshold.issueNumber)
    expect(link.similarity).toBe(mockRawResultAboveThreshold.similarity)
  })

  it("passes concatenated 'title + space + summary' as the embedding input text (spec 4.5 step 2)", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: generateEmbedding called with the exact concatenation
    expect(deps.generateEmbedding).toHaveBeenCalledWith(`${STORY_TITLE} ${STORY_SUMMARY}`)
  })

  it("calls queryMaterials with the embedding vector and limit = MAX_RELATED_MATERIALS (5)", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: queryMaterials receives the vector returned by generateEmbedding and the correct limit
    expect(deps.queryMaterials).toHaveBeenCalledWith(MOCK_EMBEDDING, MAX_RELATED_MATERIALS)
  })

  it("correctly maps a raw result with issueNumber: null to an ArchiveLink with issueNumber: null", async () => {
    // Arrange
    const deps = buildDeps({
      queryMaterials: vi.fn().mockResolvedValue([mockRawResultNoIssueNumber]),
    })

    // Act
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: nullable issueNumber is preserved in the mapped output
    expect(result).toHaveLength(1)
    expect(result[0].issueNumber).toBeNull()
    expect(result[0].title).toBe(mockRawResultNoIssueNumber.title)
    expect(result[0].url).toBe(mockRawResultNoIssueNumber.url)
    expect(result[0].similarity).toBe(mockRawResultNoIssueNumber.similarity)
  })
})

// ===========================================================================
// 3. findRelatedMaterials — threshold filtering
// ===========================================================================

describe("findRelatedMaterials — threshold filtering (spec 4.5 step 4)", () => {
  it("filters out results with similarity === 0.3 (threshold is exclusive: strictly > 0.3)", async () => {
    // Arrange
    const deps = buildDeps({
      queryMaterials: vi.fn().mockResolvedValue([mockRawResultAtThreshold]),
    })

    // Act
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: result at exact threshold is excluded
    expect(result).toHaveLength(0)
  })

  it("filters out results with similarity below 0.3", async () => {
    // Arrange
    const deps = buildDeps({
      queryMaterials: vi.fn().mockResolvedValue([mockRawResultBelowThreshold]),
    })

    // Act
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: low-similarity result is excluded
    expect(result).toHaveLength(0)
  })

  it("returns only results above 0.3 when the DB returns a mixed set", async () => {
    // Arrange: mix of above, at, and below threshold
    const deps = buildDeps({
      queryMaterials: vi.fn().mockResolvedValue([
        mockRawResultAboveThreshold,   // similarity 0.72 — included
        mockRawResultNoIssueNumber,    // similarity 0.55 — included
        mockRawResultAtThreshold,      // similarity 0.3  — excluded
        mockRawResultBelowThreshold,   // similarity 0.15 — excluded
      ]),
    })

    // Act
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: only the two above-threshold results survive
    expect(result).toHaveLength(2)
    expect(result.every((link) => link.similarity > SIMILARITY_THRESHOLD)).toBe(true)
  })

  it("returns an empty array when queryMaterials returns an empty array", async () => {
    // Arrange
    const deps = buildDeps({
      queryMaterials: vi.fn().mockResolvedValue([]),
    })

    // Act
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert
    expect(result).toEqual([])
  })
})

// ===========================================================================
// 4. findRelatedMaterials — non-blocking error handling (spec 4.5 fallback)
// ===========================================================================

describe("findRelatedMaterials — non-blocking (spec 4.5: 'skips if DB unavailable')", () => {
  it("returns empty array when generateEmbedding throws — does not propagate the error", async () => {
    // Arrange
    const deps = buildDeps({
      generateEmbedding: vi.fn().mockRejectedValue(new Error("OpenAI API unreachable")),
    })

    // Act — must not throw
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: graceful fallback, no throw
    expect(result).toEqual([])
  })

  it("returns empty array when queryMaterials throws — does not propagate the error", async () => {
    // Arrange
    const deps = buildDeps({
      queryMaterials: vi.fn().mockRejectedValue(new Error("Archive DB connection refused")),
    })

    // Act — must not throw
    const result = await findRelatedMaterials(STORY_TITLE, STORY_SUMMARY, deps)

    // Assert: graceful fallback, no throw
    expect(result).toEqual([])
  })
})
