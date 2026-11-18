"use client"

/**
 * The full-page story reading surface (`/stories/[id]`).
 *
 * The body lives in `StoryArticle` (shared with the side peek, RAD-345); this
 * file owns what is page-specific: the batch handlers that call the API and
 * then navigate or refresh, the delete dialog, and the `ReadingShell` chrome.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2, Archive, ArchiveRestore, Send, NotebookPen } from "lucide-react"
import { toast } from "sonner"
import { DeleteMaterialDialog } from "@/components/materials/delete-material-dialog"
import { StoryArticle, type StoryArticleStory } from "./story-article"
import { ReadingShell } from "@/components/reading/reading-layout"
import type { ReadingAction } from "@/components/reading/reading-actions"

export function StoryDetail({ story, hasNotionIntegration = false }: { story: StoryArticleStory; hasNotionIntegration?: boolean }) {
  const router = useRouter()
  const [isProcessing, setIsProcessing] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const materialIds = story.materials.map(m => m.id)
  const isAllArchived = story.materials.length > 0 && story.materials.every(m => m.userStatus === "ARCHIVED")

  async function handleDelete(feedback?: { sourceFeedback?: string; globalFeedback?: string }) {
    setIsProcessing(true)
    try {
      const results = await Promise.allSettled(materialIds.map(id =>
        fetch(`/api/posts/${id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(feedback || {}),
        }).then(res => { if (!res.ok) throw new Error() })
      ))
      const failedCount = results.filter(r => r.status === "rejected").length
      if (failedCount > 0) {
        toast.error(`${failedCount} of ${materialIds.length} posts failed to delete`)
      } else {
        toast.success("Story deleted")
        router.push("/posts")
      }
    } catch {
      toast.error("Network error")
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleArchive() {
    setIsProcessing(true)
    try {
      const results = await Promise.allSettled(materialIds.map(id =>
        fetch(`/api/posts/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userStatus: "ARCHIVED" }),
        }).then(res => { if (!res.ok) throw new Error() })
      ))
      const failedCount = results.filter(r => r.status === "rejected").length
      if (failedCount > 0) {
        toast.error(`${failedCount} posts failed to archive`)
      } else {
        toast.success(`${materialIds.length} posts archived`)
        router.push("/posts")
      }
    } catch {
      toast.error("Network error")
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleRestore() {
    setIsProcessing(true)
    try {
      const results = await Promise.allSettled(materialIds.map(id =>
        fetch(`/api/posts/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userStatus: "NEW" }),
        }).then(res => { if (!res.ok) throw new Error() })
      ))
      const failedCount = results.filter(r => r.status === "rejected").length
      if (failedCount > 0) {
        toast.error(`${failedCount} posts failed to restore`)
      } else {
        toast.success(`${materialIds.length} posts restored`)
        router.refresh()
      }
    } catch {
      toast.error("Network error")
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleSendToNotion() {
    setIsProcessing(true)
    try {
      const res = await fetch(`/api/stories/${story.id}/notion`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Failed to send to Notion")
      }
      toast.success("Story sent to Notion")
      router.refresh()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to send to Notion")
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleFeedbackPropagation(feedbackType: "LIKE" | "DISLIKE") {
    // Primary material feedback is handled by MaterialFeedbackButtons
    const remaining = materialIds.slice(1)
    if (remaining.length > 0) {
      const results = await Promise.allSettled(remaining.map(id =>
        fetch(`/api/posts/${id}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedbackType }),
        }).then(res => { if (!res.ok) throw new Error() })
      ))
      const failedCount = results.filter(r => r.status === "rejected").length
      if (failedCount > 0) {
        toast.error(`Feedback failed for ${failedCount} of ${remaining.length} related posts`)
      }
    }
    if (feedbackType === "DISLIKE") {
      setTimeout(() => handleArchive(), 450)
    }
  }

  // A Telegram-pipeline story can carry inboxItems and no materials. The bulk
  // handlers map over materialIds, so an empty set resolves to a success toast
  // ("0 posts archived") for an operation that did nothing.
  const hasMaterials = materialIds.length > 0

  const actions: ReadingAction[] = [
    ...(story.notionUrl
      ? [{ key: "notion-open", label: "Open in Notion", icon: NotebookPen, href: story.notionUrl } satisfies ReadingAction]
      : []),
    isAllArchived
      ? { key: "restore", label: "Restore", icon: ArchiveRestore, onSelect: handleRestore, disabled: isProcessing || !hasMaterials }
      : { key: "archive", label: "Archive", icon: Archive, onSelect: handleArchive, disabled: isProcessing || !hasMaterials },
    ...(hasNotionIntegration && story.status !== "SENT_TO_NOTION"
      ? [{ key: "notion-send", label: "Send to Notion", icon: Send, onSelect: handleSendToNotion, disabled: isProcessing } satisfies ReadingAction]
      : []),
    {
      key: "delete",
      label: "Delete",
      icon: Trash2,
      onSelect: () => setDeleteDialogOpen(true),
      disabled: isProcessing || !hasMaterials,
      destructive: true,
    },
  ]

  return (
    <>
      <ReadingShell backFallback="/stories">
        <StoryArticle story={story} actions={actions} onFeedback={handleFeedbackPropagation} />
      </ReadingShell>

      <DeleteMaterialDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDelete}
        materialTitle={story.title}
        isStory
      />
    </>
  )
}
