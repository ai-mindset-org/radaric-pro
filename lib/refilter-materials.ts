/**
 * refilterMaterials — re-evaluate all non-archived materials using current AI filtering rules.
 *
 * Feature: "Run AI Rules"
 */

export interface RefilterDeps {
  db: {
    material: {
      findMany: (args: unknown) => Promise<
        Array<{
          id: string
          title: string
          content: string
          url: string
          sourceId: string
          aiEvaluation: string | null
          aiConfidence: number | null
          aiReasoning: string | null
          feed: { userId: string }
        }>
      >
      update: (args: unknown) => Promise<unknown>
    }
  }
  evaluateMaterial: (args: {
    material: { title: string; content: string; url: string }
    sourceId: string
    userId: string
  }) => Promise<{ relevant: boolean; confidence: number; reasoning: string }>
}

export interface RefilterResult {
  total: number
  evaluated: number
  flippedToApproved: number
  flippedToFiltered: number
  unchanged: number
  errors: number
}

export const EXCLUDED_STATUSES = ["DELETED", "ARCHIVED", "SENT_TO_STORIES", "SENT_TO_NOTION"] as const

/** Number of materials to evaluate concurrently during refilter */
export const REFILTER_CONCURRENCY = 3

export interface RefilterOptions {
  /** Called after each material is processed. Return false to abort. */
  onProgress?: (current: number, total: number, result: RefilterResult) => boolean | void
  /** AbortSignal to cancel processing mid-run. */
  signal?: AbortSignal
  /** Scope the re-filter to materials belonging to a single feed (RAD-203 per-source view). */
  feedId?: string
  /**
   * Scope the re-filter to an explicit set of sources (RAD-393 folder scope;
   * the route resolves the folder's visible members). Takes precedence over
   * `feedId` when both are present.
   */
  sourceIds?: string[]
}

export async function refilterMaterials(
  userId: string,
  deps: RefilterDeps,
  options?: RefilterOptions
): Promise<RefilterResult> {
  const materials = await deps.db.material.findMany({
    where: {
      // hidden:false: never re-evaluate a self-filling collection's monitor
      // materials with the global filter prompt — that would flip their
      // APPROVED state and corrupt the tracked-question answer's source set.
      feed: { userId, hidden: false },
      userStatus: { notIn: [...EXCLUDED_STATUSES] },
      ...(options?.sourceIds
        ? { sourceId: { in: options.sourceIds } }
        : options?.feedId
          ? { sourceId: options.feedId }
          : {}),
    },
    select: {
      id: true,
      title: true,
      content: true,
      url: true,
      sourceId: true,
      aiEvaluation: true,
      aiConfidence: true,
      aiReasoning: true,
      feed: { select: { userId: true } },
    },
  })

  const result: RefilterResult = {
    total: materials.length,
    evaluated: 0,
    flippedToApproved: 0,
    flippedToFiltered: 0,
    unchanged: 0,
    errors: 0,
  }

  // Process materials in concurrent batches for speed
  for (let i = 0; i < materials.length; i += REFILTER_CONCURRENCY) {
    if (options?.signal?.aborted) break

    const batch = materials.slice(i, i + REFILTER_CONCURRENCY)

    await Promise.all(
      batch.map(async (material) => {
        if (options?.signal?.aborted) return

        try {
          const evaluation = await deps.evaluateMaterial({
            material: {
              title: material.title,
              content: material.content,
              url: material.url,
            },
            sourceId: material.sourceId,
            userId,
          })

          const newEvaluation = evaluation.relevant ? "APPROVED" : "FILTERED"
          const oldEvaluation = material.aiEvaluation

          if (newEvaluation !== oldEvaluation) {
            await deps.db.material.update({
              where: { id: material.id },
              data: {
                aiEvaluation: newEvaluation,
                aiConfidence: evaluation.confidence,
                aiReasoning: evaluation.reasoning,
              },
            })

            if (newEvaluation === "APPROVED") {
              result.flippedToApproved++
            } else {
              result.flippedToFiltered++
            }
          } else {
            await deps.db.material.update({
              where: { id: material.id },
              data: {
                aiConfidence: evaluation.confidence,
                aiReasoning: evaluation.reasoning,
              },
            })

            result.unchanged++
          }

          result.evaluated++
        } catch (err) {
          console.error(`[refilter] Failed material ${material.id}:`, err)
          result.errors++
        }
      })
    )

    // Report progress after each batch completes
    const processed = Math.min(i + REFILTER_CONCURRENCY, materials.length)
    options?.onProgress?.(processed, materials.length, result)
  }

  return result
}
