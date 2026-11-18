"use client"

/**
 * The story peek (RAD-345) — fetch, cache and actions for a story inside the
 * panel/sheet.
 *
 * A story cell in the grid carries only its headline and summary, so the peek
 * always reads `GET /api/stories/[id]` (extended to include the constituent
 * materials, the same shape `/stories/[id]` renders). Results are memoised per
 * session so re-opening a story is instant, and the cache entry is dropped
 * after every action — a stale `userStatus` would otherwise keep offering
 * "Archive" on a story that is already archived.
 *
 * The batch handlers receive the ids from the **fetched** story, not from the
 * grid cell: the peek may show more materials than the cell had loaded, and
 * acting on a subset would leave the rest untouched.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Archive, ArchiveRestore, NotebookPen, Send, Trash2 } from "lucide-react"
import { DeleteMaterialDialog } from "@/components/materials/delete-material-dialog"
import { StoryArticle, type StoryArticleStory } from "./story-article"
import { PeekNotice, PeekSkeleton } from "@/components/peek/peek-states"
import type { ReadingAction } from "@/components/reading/reading-actions"

/**
 * Session memo — survives the peek unmounting. Bounded on purpose: each entry
 * carries every material's full content, so an unbounded map would hold a
 * whole session's reading corpus.
 */
const storyCache = new Map<string, StoryArticleStory>()
const STORY_CACHE_MAX = 10

/**
 * Drop one story (or everything). Called after an action taken **anywhere** —
 * the peek's own handlers and the grid's story batch handlers — because a
 * cached copy would otherwise keep offering "Archive" on a story that is
 * already archived, or render a story the grid has dissolved.
 */
export function invalidateStoryPeekCache(storyId?: string) {
  if (storyId) storyCache.delete(storyId)
  else storyCache.clear()
}

/** Test seam: the cache is module state and must not leak between tests. */
export function clearStoryPeekCache() {
  invalidateStoryPeekCache()
}

function cacheStory(id: string, story: StoryArticleStory) {
  storyCache.set(id, story)
  while (storyCache.size > STORY_CACHE_MAX) {
    const oldest = storyCache.keys().next().value
    if (oldest === undefined) break
    storyCache.delete(oldest)
  }
}

export function StoryPeek({
  storyId,
  hasNotionIntegration,
  onArchive,
  onRestore,
  onDelete,
  onSendToNotion,
  onFeedback,
  onOpenMaterial,
  onClosePeek,
  onTitleResolved,
}: {
  storyId: string
  hasNotionIntegration: boolean
  onArchive: (materialIds: string[]) => Promise<void> | void
  onRestore: (materialIds: string[]) => Promise<void> | void
  onDelete: (materialIds: string[], feedback?: { sourceFeedback?: string; globalFeedback?: string }) => Promise<boolean | void> | boolean | void
  onSendToNotion?: (storyId: string, materialIds: string[]) => Promise<void> | void
  onFeedback?: (primaryMaterialId: string, materialIds: string[], feedbackType: "LIKE" | "DISLIKE") => Promise<void> | void
  onOpenMaterial: (materialId: string) => void
  onClosePeek: () => void
  onTitleResolved?: (title: string) => void
}) {
  const [story, setStory] = useState<StoryArticleStory | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<"error" | "gone" | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const generationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/stories/${storyId}`, { signal: controller.signal })
      if (generation !== generationRef.current) return
      if (res.status === 404) {
        storyCache.delete(storyId)
        setStory(null)
        setError("gone")
        return
      }
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = (await res.json()) as StoryArticleStory
      if (generation !== generationRef.current) return
      cacheStory(storyId, data)
      setStory(data)
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return
      if (generation !== generationRef.current) return
      setError("error")
    } finally {
      if (generation === generationRef.current) setIsLoading(false)
    }
  }, [storyId])

  useEffect(() => {
    const cached = storyCache.get(storyId)
    if (cached) {
      setStory(cached)
      setError(null)
      setIsLoading(false)
      return
    }
    setStory(null)
    void load()
  }, [storyId, load])

  useEffect(() => {
    if (story?.title) onTitleResolved?.(story.title)
  }, [story?.title, onTitleResolved])

  const materialIds = story?.materials.map(m => m.id) ?? []
  const hasMaterials = materialIds.length > 0
  const isAllArchived = hasMaterials && story!.materials.every(m => m.userStatus === "ARCHIVED")

  /** After a batch action the cached and displayed copies are both suspect. */
  async function runAndRefresh(run: () => Promise<void> | void) {
    await run()
    invalidateStoryPeekCache(storyId)
    void load()
  }

  async function handleDelete(feedback?: { sourceFeedback?: string; globalFeedback?: string }) {
    const ok = await onDelete(materialIds, feedback)
    // `false` means the batch failed (the list reports it and rolls back) —
    // the story is still there, so the peek must not vanish with it.
    if (ok === false) return
    invalidateStoryPeekCache(storyId)
    onClosePeek()
  }

  const actions: ReadingAction[] = story
    ? [
        ...(story.notionUrl
          ? [{ key: "notion-open", label: "Open in Notion", icon: NotebookPen, href: story.notionUrl } satisfies ReadingAction]
          : []),
        isAllArchived
          ? {
              key: "restore",
              label: "Restore",
              icon: ArchiveRestore,
              disabled: !hasMaterials,
              onSelect: () => runAndRefresh(() => onRestore(materialIds)),
            }
          : {
              key: "archive",
              label: "Archive",
              icon: Archive,
              disabled: !hasMaterials,
              onSelect: () => runAndRefresh(() => onArchive(materialIds)),
            },
        ...(hasNotionIntegration && onSendToNotion && story.status !== "SENT_TO_NOTION"
          ? [
              {
                key: "notion-send",
                label: "Send to Notion",
                icon: Send,
                busy: isSending,
                onSelect: async () => {
                  setIsSending(true)
                  try {
                    await runAndRefresh(() => onSendToNotion(storyId, materialIds))
                  } finally {
                    setIsSending(false)
                  }
                },
              } satisfies ReadingAction,
            ]
          : []),
        {
          key: "delete",
          label: "Delete",
          icon: Trash2,
          disabled: !hasMaterials,
          onSelect: () => setDeleteOpen(true),
          destructive: true,
        },
      ]
    : []

  return (
    <>
      {error === "gone" ? (
        <PeekNotice
          title="This story is no longer available"
          body="It may have been deleted, or it belongs to another account."
          onClose={onClosePeek}
        />
      ) : error === "error" ? (
        <PeekNotice
          title="Couldn’t load this story"
          body="Something went wrong on the way to the server."
          onRetry={() => void load()}
          onClose={onClosePeek}
        />
      ) : !story || isLoading ? (
        <PeekSkeleton label="Loading story" />
      ) : (
        <StoryArticle
          story={story}
          actions={actions}
          onOpenMaterial={onOpenMaterial}
          onFeedback={
            onFeedback
              ? (feedbackType, primaryMaterialId) => onFeedback(primaryMaterialId, materialIds, feedbackType)
              : undefined
          }
        />
      )}

      <DeleteMaterialDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        materialTitle={story?.title ?? "this story"}
        isStory
      />
    </>
  )
}
