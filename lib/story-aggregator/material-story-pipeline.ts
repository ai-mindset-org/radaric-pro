/**
 * Material Story Pipeline
 * Orchestrates story matching/grouping for APPROVED materials.
 *
 * Spec: RAD-120 Phase 3
 */

import { buildStorySystemPrompt, buildStoryUserContent, validateStoryOutput } from "./story-writer"
import type { InboxItemForStory } from "./story-writer"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MaterialRecord {
  id: string
  title: string
  content: string
  url: string | null
  rawText: string | null
  aiEvaluation: string
  userStatus: string
  storyId: string | null
  storyMatchedAt: Date | null
  feed: {
    userId: string
    name: string
    type: string
  }
}

interface StoryRecord {
  id: string
  userId: string
  title: string
  languageFlag: string | null
  summary: string
  body: string
  keyPoints: string[]
  sourceUrls: string[]
  rubrics: string[]
  archiveLinks: unknown
  notionPageId: string | null
  notionUrl: string | null
  status: string
  version: number
  inboxItems?: unknown[]
  materials?: MaterialRecord[]
}

/** A transaction-scoped subset used to atomically create a story + claim its materials. */
interface MaterialPipelineTx {
  story: { create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }> }
  material: {
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>
  }
}

export interface MaterialPipelineDeps {
  db: {
    material: {
      findMany: (args: Record<string, unknown>) => Promise<MaterialRecord[]>
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>
    }
    story: {
      create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>
      findMany: (args: Record<string, unknown>) => Promise<unknown[]>
      findUnique: (args: { where: { id: string }; include?: Record<string, unknown> }) => Promise<StoryRecord | null>
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
    }
    userSettings: {
      findUnique: (args: { where: { userId: string } }) => Promise<{
        userId: string
        storySystemPrompt: string | null
        storyLanguage: string
      } | null>
    }
    /** Atomic create-story-and-link-materials, so a pairing can't half-commit a 1-material story. */
    $transaction: <T>(fn: (tx: MaterialPipelineTx) => Promise<T>) => Promise<T>
  }
  matchContent: (
    content: { title: string; content: string; url: string | null; rawText: string | null },
    userId: string,
    deps: {
      db: {
        story: { findMany: (args: Record<string, unknown>) => Promise<unknown[]> }
        inboxItem?: { findUnique: (args: Record<string, unknown>) => Promise<unknown> }
      }
      matchWithAI: (systemPrompt: string, userContent: string) => Promise<unknown>
    },
    opts?: {
      candidateMaterials?: Array<{ id: string; title: string; content: string; url: string | null }>
      requireSignal?: boolean
    }
  ) => Promise<{ match: string | null; matchType: "story" | "material" | null; isNew: boolean; reasoning: string }>
  generateStory: (systemPrompt: string, userContent: string) => Promise<unknown>
  matchWithAI: (systemPrompt: string, userContent: string) => Promise<unknown>
}

export interface MaterialPipelineSummary {
  storiesCreated: number
  storiesUpdated: number
  materialsProcessed: number
  materialsSkipped: number
  errors?: number
}

// ---------------------------------------------------------------------------
// processApprovedMaterials
// ---------------------------------------------------------------------------

/** How far back to look for standalone posts that could pair into a story. */
const POOL_LOOKBACK_DAYS = 30

/** Upper bound on the standalone candidate pool per call — keeps the SSE
 *  one-at-a-time path cheap as ungrouped posts accumulate within the window. */
const POOL_MAX_CANDIDATES = 500

/**
 * Process a list of material IDs into stories. For each APPROVED, unlinked post:
 *  - join an existing story it matches, OR
 *  - pair with another standalone post it matches → form a NEW two-post story, OR
 *  - leave it standalone (shown verbatim) when nothing genuinely matches.
 *
 * A lone post never becomes a single-material story — that's what made the feed
 * render AI summaries instead of original posts. The one exception is the explicit
 * manual "send to stories" action, which passes `allowSingletonStory: true`.
 *
 * Only processes APPROVED materials owned by the given userId that have no storyId yet.
 * Error-resilient: failures on individual materials don't stop processing.
 */
export async function processApprovedMaterials(
  materialIds: string[],
  userId: string,
  deps: MaterialPipelineDeps,
  opts: { allowSingletonStory?: boolean } = {}
): Promise<MaterialPipelineSummary> {
  // EC-1: empty input → early return, no DB calls
  if (materialIds.length === 0) {
    return {
      storiesCreated: 0,
      storiesUpdated: 0,
      materialsProcessed: 0,
      materialsSkipped: 0,
    }
  }

  // Fetch materials by IDs with feed relation
  const materials = await deps.db.material.findMany({
    where: {
      id: { in: materialIds },
    },
    include: {
      feed: true,
    },
  })

  // Filter: only APPROVED materials owned by userId without an existing storyId
  const eligible: MaterialRecord[] = []
  let materialsSkipped = 0

  for (const material of materials) {
    const isApproved = material.aiEvaluation === "APPROVED"
    const isOwned = material.feed?.userId === userId
    const hasNoStory = material.storyId === null
    const isLive = !["DELETED", "ARCHIVED"].includes(material.userStatus)

    if (!isApproved || !isOwned || !hasNoStory || !isLive) {
      materialsSkipped++
    } else {
      eligible.push(material)
    }
  }

  // Candidate pool of standalone APPROVED posts a material can PAIR with to form a
  // story. Fetched from the DB (not the in-call batch) so the SSE one-at-a-time
  // path still clusters across calls — when post A pairs with persisted post B, B's
  // storyId gets set, and B's own later iteration is skipped via `hasNoStory`.
  // Intentionally GLOBAL (not feedId-scoped) even for per-feed Group Stories: a
  // story's value is grouping the same topic across sources. Excludes hidden
  // (self-filling monitor) feeds and DELETED/ARCHIVED posts. Bounded to the most
  // recent rows so it stays cheap as standalone posts accumulate over the window.
  let candidatePool: MaterialRecord[] = []
  if (eligible.length > 0) {
    const poolSince = new Date()
    poolSince.setDate(poolSince.getDate() - POOL_LOOKBACK_DAYS)
    candidatePool = await deps.db.material.findMany({
      where: {
        feed: { userId, hidden: false },
        aiEvaluation: "APPROVED",
        storyId: null,
        userStatus: { notIn: ["DELETED", "ARCHIVED"] },
        createdAt: { gte: poolSince },
      },
      include: { feed: true },
      orderBy: { createdAt: "desc" },
      take: POOL_MAX_CANDIDATES,
    })
  }
  const poolById = new Map(candidatePool.map((m) => [m.id, m]))

  let storiesCreated = 0
  let storiesUpdated = 0
  let materialsProcessed = 0
  let errors = 0
  // Materials linked to a story earlier in THIS run (as a pair partner). The DB
  // conditional link (updateMany where storyId:null) is the real race guard; this
  // set just avoids redundant AI work within a single batch run.
  const linkedThisRun = new Set<string>()

  // Process each eligible material sequentially
  for (const material of eligible) {
    if (linkedThisRun.has(material.id)) continue

    try {
      // Build minimal deps subset for matchContent
      const matcherDeps = {
        db: {
          story: deps.db.story,
        },
        matchWithAI: deps.matchWithAI,
      }

      // Standalone partners offered to the matcher: pool minus self and anything
      // already paired this run.
      const candidateMaterials = candidatePool
        .filter((m) => m.id !== material.id && !linkedThisRun.has(m.id))
        .map((m) => ({ id: m.id, title: m.title, content: m.content, url: m.url }))

      // Match against existing stories AND standalone candidate posts in one call.
      const matchResult = await deps.matchContent(
        {
          title: material.title,
          content: material.content,
          url: material.url,
          rawText: null,
        },
        userId,
        matcherDeps,
        { candidateMaterials, requireSignal: true }
      )

      if (matchResult.matchType === "story" && matchResult.match) {
        // Joins an existing (multi-post) story → link + regenerate.
        await deps.db.material.update({
          where: { id: material.id },
          data: {
            storyId: matchResult.match,
            storyMatchedAt: new Date(),
          },
        })
        await regenerateStory(matchResult.match, userId, deps)

        linkedThisRun.add(material.id)
        storiesUpdated++
        materialsProcessed++
      } else if (matchResult.matchType === "material" && matchResult.match) {
        // Matches another standalone post → form a NEW two-post story atomically.
        const partner = poolById.get(matchResult.match)
        if (partner) {
          await createPairStory(material, partner, userId, deps)
          linkedThisRun.add(material.id)
          linkedThisRun.add(partner.id)
          storiesCreated++
        }
        materialsProcessed++
      } else if (opts.allowSingletonStory) {
        // Explicit manual "send to stories" — a single post may become a story.
        await createSingletonStory(material, userId, deps)
        linkedThisRun.add(material.id)
        storiesCreated++
        materialsProcessed++
      } else {
        // No genuine cluster → leave the post standalone (rendered verbatim).
        materialsProcessed++
      }
    } catch (err) {
      console.error(`[MaterialPipeline] Failed to process material ${material.id}:`, err)
      errors++
    }
  }

  const summary: MaterialPipelineSummary = {
    storiesCreated,
    storiesUpdated,
    materialsProcessed,
    materialsSkipped,
  }

  if (errors > 0) {
    summary.errors = errors
  }

  return summary
}

// ---------------------------------------------------------------------------
// Story-building helpers
// ---------------------------------------------------------------------------

/** Map a material record into the shape the story writer consumes. */
function materialToStoryItem(mat: {
  rawText: string | null
  title: string
  content: string
  url: string | null
  feed?: { name: string; type: string } | null
}): InboxItemForStory {
  const sourceType = mat.feed?.type === "TWITTER" ? "twitter" as const
    : mat.feed?.type === "TELEGRAM" ? "telegram" as const
    : "rss" as const
  return {
    rawText: mat.rawText,
    extractedTitle: mat.title,
    extractedContent: mat.content,
    sourceChannel: mat.feed?.name ?? null,
    extractedUrl: mat.url,
    mediaUrls: [],
    telegramPostUrl: null,
    sourceType,
  }
}

/**
 * Build the Story.create data from generated output, seeding sourceUrls with the
 * constituent material URLs so the URL-exact dedup shortcut stays strong even if
 * the AI drops one from its own sourceUrls.
 */
function buildStoryCreateData(
  userId: string,
  generated: {
    title: string
    languageFlag: string
    summary: string
    body: string
    keyPoints: string[]
    sourceUrls: string[]
    rubrics: string[]
  },
  materialUrls: Array<string | null>
): Record<string, unknown> {
  const sourceUrls = Array.from(
    new Set([...materialUrls.filter((u): u is string => Boolean(u)), ...generated.sourceUrls])
  )
  return {
    userId,
    title: generated.title,
    languageFlag: generated.languageFlag,
    summary: generated.summary,
    body: generated.body,
    keyPoints: generated.keyPoints,
    sourceUrls,
    rubrics: generated.rubrics,
    status: "DRAFT",
  }
}

/** Generate a story from a user's settings + the given material items. */
async function generateStoryFor(
  items: InboxItemForStory[],
  userId: string,
  deps: MaterialPipelineDeps
) {
  const userSettings = await deps.db.userSettings.findUnique({ where: { userId } })
  const storyLanguage = userSettings?.storyLanguage ?? "en"
  const systemPrompt = buildStorySystemPrompt(userSettings?.storySystemPrompt ?? null, storyLanguage)
  const userContent = buildStoryUserContent(items)
  const rawOutput = await deps.generateStory(systemPrompt, userContent)
  const result = validateStoryOutput(rawOutput)
  if (!result.success || !result.story) {
    throw new Error(`AI output validation failed: ${result.error}`)
  }
  return result.story
}

/**
 * Form a NEW story from two standalone posts and link BOTH atomically. The
 * conditional updateMany (storyId:null) means a partner already grabbed by a
 * concurrent run aborts the whole transaction — so a pairing can never half-commit
 * a 1-material story (the very artifact this change eliminates).
 */
async function createPairStory(
  m1: MaterialRecord,
  m2: MaterialRecord,
  userId: string,
  deps: MaterialPipelineDeps
): Promise<void> {
  const generated = await generateStoryFor(
    [materialToStoryItem(m1), materialToStoryItem(m2)],
    userId,
    deps
  )
  const now = new Date()

  await deps.db.$transaction(async (tx) => {
    const created = await tx.story.create({
      data: buildStoryCreateData(userId, generated, [m1.url, m2.url]),
    })
    const linkedFirst = await tx.material.updateMany({
      where: { id: m1.id, storyId: null },
      data: { storyId: created.id, storyMatchedAt: now },
    })
    if (linkedFirst.count === 0) throw new Error(`Material ${m1.id} already linked to a story`)
    const linkedSecond = await tx.material.updateMany({
      where: { id: m2.id, storyId: null },
      data: { storyId: created.id, storyMatchedAt: now },
    })
    if (linkedSecond.count === 0) throw new Error(`Material ${m2.id} already linked to a story`)
  })
}

/**
 * Create a single-material story (only the explicit manual "send to stories" path).
 * Same atomic + conditional-link guard as createPairStory: the storyId:null check
 * means a concurrent sweep that already linked this material to a genuine cluster
 * aborts this transaction instead of stealing the material into a singleton.
 */
async function createSingletonStory(
  material: MaterialRecord,
  userId: string,
  deps: MaterialPipelineDeps
): Promise<void> {
  const generated = await generateStoryFor([materialToStoryItem(material)], userId, deps)
  const now = new Date()
  await deps.db.$transaction(async (tx) => {
    const created = await tx.story.create({
      data: buildStoryCreateData(userId, generated, [material.url]),
    })
    const linked = await tx.material.updateMany({
      where: { id: material.id, storyId: null },
      data: { storyId: created.id, storyMatchedAt: now },
    })
    if (linked.count === 0) throw new Error(`Material ${material.id} already linked to a story`)
  })
}

// ---------------------------------------------------------------------------
// regenerateStory (internal helper)
// ---------------------------------------------------------------------------

/**
 * Re-generate an existing story incorporating all linked materials.
 * Similar to updateExistingStory in pipeline.ts but using MaterialPipelineDeps.
 */
async function regenerateStory(
  storyId: string,
  userId: string,
  deps: MaterialPipelineDeps
): Promise<void> {
  const story = await deps.db.story.findUnique({
    where: { id: storyId },
    include: { materials: { include: { feed: true } } },
  })
  if (!story) return

  const userSettings = await deps.db.userSettings.findUnique({
    where: { userId },
  })

  const storyLanguage = userSettings?.storyLanguage ?? "en"
  const systemPrompt = buildStorySystemPrompt(userSettings?.storySystemPrompt ?? null, storyLanguage)

  const materialItems: InboxItemForStory[] = (story.materials ?? []).map(materialToStoryItem)

  const userContent = buildStoryUserContent(materialItems.length > 0 ? materialItems : [
    {
      rawText: null,
      extractedTitle: story.title,
      extractedContent: story.summary,
      sourceChannel: null,
      extractedUrl: story.sourceUrls[0] ?? null,
      mediaUrls: [],
      telegramPostUrl: null,
    },
  ])

  const rawOutput = await deps.generateStory(systemPrompt, userContent)
  const result = validateStoryOutput(rawOutput)

  if (!result.success || !result.story) {
    throw new Error(`AI output validation failed: ${result.error}`)
  }

  const updatedStory = result.story

  // Re-seed sourceUrls with the constituent material URLs (same invariant as
  // buildStoryCreateData) so the URL-exact dedup shortcut survives regeneration
  // even if the AI drops a URL from its own output.
  const materialUrls = (story.materials ?? []).map((m) => m.url)

  await deps.db.story.update({
    where: { id: storyId },
    data: {
      title: updatedStory.title,
      languageFlag: updatedStory.languageFlag,
      summary: updatedStory.summary,
      body: updatedStory.body,
      keyPoints: updatedStory.keyPoints,
      sourceUrls: Array.from(
        new Set([...materialUrls.filter((u): u is string => Boolean(u)), ...updatedStory.sourceUrls])
      ),
      rubrics: updatedStory.rubrics,
      version: { increment: 1 },
      status: "DRAFT",
    },
  })
}
