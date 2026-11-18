/**
 * Archive Linker — spec 4.5
 *
 * Searches the external archive PostgreSQL database for materials semantically
 * similar to a given story and returns formatted links for the "See also" section.
 *
 * This module is NON-BLOCKING: all errors are caught internally and an empty
 * array is returned so the story can be published without "See also" links.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum cosine similarity (exclusive) for a result to be included */
export const SIMILARITY_THRESHOLD = 0.3

/** Maximum number of related materials to return */
export const MAX_RELATED_MATERIALS = 5

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A raw result row returned by the archive database pgvector query */
export interface ArchiveRawResult {
  title: string
  url: string
  description: string
  issueNumber: number | null
  rubrics: string[]
  similarity: number
}

/** A mapped link ready for storage and display in the "See also" section */
export interface ArchiveLink {
  title: string
  url: string
  issueNumber: number | null
  similarity: number
}

/** Dependency injection interface for testability */
export interface ArchiveLinkerDeps {
  /** Generate a 1536-dimension embedding for the given text */
  generateEmbedding: (text: string) => Promise<number[]>
  /** Query the archive database for the top-k similar materials */
  queryMaterials: (embedding: number[], limit: number) => Promise<ArchiveRawResult[]>
}

// ---------------------------------------------------------------------------
// findRelatedMaterials
// ---------------------------------------------------------------------------

/**
 * Finds archive materials related to a story (spec 4.5).
 *
 * Steps:
 *  1. Concatenate storyTitle + " " + storySummary as the embedding input.
 *  2. Generate an embedding vector via deps.generateEmbedding.
 *  3. Query the archive database for top-MAX_RELATED_MATERIALS materials.
 *  4. Filter results with similarity strictly > SIMILARITY_THRESHOLD.
 *  5. Map raw results to ArchiveLink format.
 *
 * Non-blocking: any error causes an empty array to be returned so the story
 * pipeline can continue without "See also" links.
 */
export async function findRelatedMaterials(
  storyTitle: string,
  storySummary: string,
  deps: ArchiveLinkerDeps
): Promise<ArchiveLink[]> {
  try {
    const inputText = `${storyTitle} ${storySummary}`
    const embedding = await deps.generateEmbedding(inputText)
    const rawResults = await deps.queryMaterials(embedding, MAX_RELATED_MATERIALS)

    return rawResults
      .filter((result) => result.similarity > SIMILARITY_THRESHOLD)
      .map((result): ArchiveLink => ({
        title: result.title,
        url: result.url,
        issueNumber: result.issueNumber,
        similarity: result.similarity,
      }))
  } catch {
    return []
  }
}
