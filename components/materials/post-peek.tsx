"use client"

/**
 * The post peek (RAD-345) — data resolution plus actions for a material inside
 * the panel/sheet.
 *
 * Resolution order, cheapest first:
 *   1. the live list copy (the list's own state, so an action's optimistic
 *      update shows here immediately);
 *   2. the snapshot the caller took when the peek opened (a list reset — a
 *      parse finishing, `router.refresh()` — must not blank an open peek);
 *   3. `GET /api/posts/[id]` — deep links to an item that is not on the loaded
 *      page. The route's GET ignores soft-deletes, so a deleted post is treated
 *      as "no longer available" here rather than being resurrected by a history
 *      link.
 *
 * Actions call the caller's handlers (the list's optimistic ones) so the grid
 * behind the panel updates in the same commit; deleting closes the peek.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Send, Trash2 } from "lucide-react"
import { DeleteMaterialDialog } from "./delete-material-dialog"
import { MaterialArticle, baseMaterialActions, type MaterialArticleMaterial } from "./material-article"
import { PeekNotice, PeekSkeleton } from "@/components/peek/peek-states"
import type { ReadingAction } from "@/components/reading/reading-actions"

export function PostPeek({
  materialId,
  material,
  hasNotionIntegration,
  onDelete,
  onArchive,
  onRestore,
  onSendToNotion,
  onClosePeek,
  onTitleResolved,
}: {
  materialId: string
  material: MaterialArticleMaterial | null
  hasNotionIntegration: boolean
  onDelete: (id: string, feedback?: { sourceFeedback?: string; globalFeedback?: string }) => Promise<boolean | void> | boolean | void
  onArchive: (id: string) => Promise<void> | void
  onRestore: (id: string) => Promise<void> | void
  onSendToNotion?: (id: string) => Promise<void> | void
  /** The item cannot stay open (deleted, gone) — the caller closes the peek. */
  onClosePeek: () => void
  onTitleResolved?: (title: string) => void
}) {
  const [fetched, setFetched] = useState<MaterialArticleMaterial | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<"error" | "gone" | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
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
      const res = await fetch(`/api/posts/${materialId}`, { signal: controller.signal })
      if (generation !== generationRef.current) return
      if (res.status === 404) {
        setFetched(null)
        setError("gone")
        return
      }
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = await res.json()
      if (generation !== generationRef.current) return
      if (data?.userStatus === "DELETED") {
        setFetched(null)
        setError("gone")
        return
      }
      setFetched(data as MaterialArticleMaterial)
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return
      if (generation !== generationRef.current) return
      setError("error")
    } finally {
      if (generation === generationRef.current) setIsLoading(false)
    }
  }, [materialId])

  useEffect(() => {
    if (material) {
      // The list already has this item; no request, and a previous target's
      // fetch result must not leak into this one.
      setFetched(null)
      setError(null)
      setIsLoading(false)
      generationRef.current++
      return
    }
    void load()
  }, [material, materialId, load])

  const resolved = material ?? fetched

  useEffect(() => {
    if (resolved?.title) onTitleResolved?.(resolved.title)
  }, [resolved?.title, onTitleResolved])

  async function handleDelete(feedback?: { sourceFeedback?: string; globalFeedback?: string }) {
    const ok = await onDelete(materialId, feedback)
    // `false` means the delete failed (the list restores the card and toasts) —
    // closing here would take away the post the user is still looking at.
    if (ok === false) return
    onClosePeek()
  }

  // A fetched copy (deep link) is not in the list's state, so re-read it after
  // an action instead of guessing at the result.
  const refreshFetched = () => {
    if (!material) void load()
  }

  const actions: ReadingAction[] = resolved
    ? [
        ...baseMaterialActions(resolved, {
          onArchive: async () => {
            await onArchive(materialId)
            refreshFetched()
          },
          onRestore: async () => {
            await onRestore(materialId)
            refreshFetched()
          },
        }),
        ...(hasNotionIntegration && onSendToNotion && resolved.userStatus !== "SENT_TO_NOTION"
          ? [
              {
                key: "notion",
                label: "Send to Notion",
                icon: Send,
                busy: isSending,
                onSelect: async () => {
                  setIsSending(true)
                  try {
                    await onSendToNotion(materialId)
                    refreshFetched()
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
          onSelect: () => setDeleteOpen(true),
          destructive: true,
        },
      ]
    : []

  return (
    <>
      {error === "gone" ? (
        <PeekNotice
          title="This post is no longer available"
          body="It may have been deleted, or it belongs to another account."
          onClose={onClosePeek}
        />
      ) : error === "error" ? (
        <PeekNotice
          title="Couldn’t load this post"
          body="Something went wrong on the way to the server."
          onRetry={() => void load()}
          onClose={onClosePeek}
        />
      ) : !resolved || isLoading ? (
        <PeekSkeleton label="Loading post" />
      ) : (
        <MaterialArticle material={resolved} actions={actions} variant="peek" />
      )}

      <DeleteMaterialDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        materialTitle={resolved?.title ?? "this post"}
      />
    </>
  )
}
