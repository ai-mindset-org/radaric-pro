/**
 * Dissolve auto-created single-material stories.
 *
 * Before the cluster-only rewrite, every approved post that didn't match an existing
 * story got wrapped in its own single-material story, so the feed rendered an AI
 * summary instead of the original post. This one-time backfill detaches those lone
 * posts and deletes the orphan stories so they revert to their original content.
 *
 * Scope (all must hold): DRAFT, never exported to Notion, ≤1 material, 0 inbox items,
 * and the lone material wasn't deliberately sent by the user. That deliberately spares:
 *   - multi-source stories (genuine clusters)
 *   - Notion-exported stories (deleting would orphan the page / risk re-export)
 *   - inbox-backed editorial stories (the intentional Story Aggregator pipeline)
 *   - manually "sent to stories" posts (explicit user intent)
 */

/** A material's userStatus that signals a deliberate "make this a story" action. */
const DELIBERATE_USER_STATUSES = ["SENT_TO_STORIES", "SENT_TO_NOTION"]

interface DissolveStory {
  id: string
  materials: Array<{ id: string; userStatus: string }>
  _count: { inboxItems: number }
}

export interface DissolveDeps {
  db: {
    story: {
      findMany: (args: Record<string, unknown>) => Promise<DissolveStory[]>
      delete: (args: { where: { id: string } }) => Promise<unknown>
    }
    material: {
      updateMany: (args: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => Promise<{ count: number }>
    }
  }
}

export interface DissolveSummary {
  dissolved: number
  materialsDetached: number
}

export async function dissolveSingleMaterialStories(
  userId: string,
  deps: DissolveDeps
): Promise<DissolveSummary> {
  // DB-level guard: only DRAFT, never-exported stories are even fetched.
  const candidates = await deps.db.story.findMany({
    where: {
      userId,
      status: "DRAFT",
      notionPageId: null,
    },
    include: {
      materials: { select: { id: true, userStatus: true } },
      _count: { select: { inboxItems: true } },
    },
  })

  let dissolved = 0
  let materialsDetached = 0

  for (const story of candidates) {
    if (story._count.inboxItems > 0) continue // inbox-backed editorial story
    if (story.materials.length > 1) continue // genuine multi-source cluster

    const lone = story.materials[0]
    if (lone && DELIBERATE_USER_STATUSES.includes(lone.userStatus)) continue // user intent

    // Detach the material first (robust even though Material.story FK defaults to
    // SetNull), then delete the now-orphan story.
    if (lone) {
      const res = await deps.db.material.updateMany({
        where: { id: lone.id, storyId: story.id },
        data: { storyId: null, storyMatchedAt: null },
      })
      materialsDetached += res.count
    }
    await deps.db.story.delete({ where: { id: story.id } })
    dissolved++
  }

  return { dissolved, materialsDetached }
}
