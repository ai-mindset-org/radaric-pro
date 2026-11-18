"use client"

/**
 * The full-page material reading surface (`/posts/[id]`).
 *
 * Everything below the shell lives in `MaterialArticle` (shared with the side
 * peek, RAD-345); this file owns what is page-specific: the handlers that call
 * the API and then navigate or refresh, the delete dialog with its feedback
 * capture, and the `ReadingShell` chrome (back bar, card frame, gutters).
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2, Send } from "lucide-react"
import { toast } from "sonner"
import { DeleteMaterialDialog } from "./delete-material-dialog"
import { MaterialArticle, baseMaterialActions, type MaterialArticleMaterial } from "./material-article"
import { ReadingShell } from "@/components/reading/reading-layout"
import type { ReadingAction } from "@/components/reading/reading-actions"

interface MaterialDetailPageProps {
  material: MaterialArticleMaterial
  hasNotionIntegration?: boolean
  initialSaved?: boolean
}

export function MaterialDetailPage({
  material,
  hasNotionIntegration = false,
}: MaterialDetailPageProps) {
  const router = useRouter()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isSendingToNotion, setIsSendingToNotion] = useState(false)

  async function handleDelete(feedback?: { sourceFeedback?: string; globalFeedback?: string }) {
    try {
      const res = await fetch(`/api/posts/${material.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedback || {}),
      })
      if (!res.ok) throw new Error()
      toast.success("Post deleted")
      router.push("/posts")
    } catch {
      toast.error("Failed to delete post")
    }
  }

  async function handleArchive() {
    try {
      const res = await fetch(`/api/posts/${material.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userStatus: "ARCHIVED" }),
      })
      if (!res.ok) throw new Error()
      toast.success("Post archived")
      router.push("/posts")
    } catch {
      toast.error("Failed to archive post")
    }
  }

  async function handleRestore() {
    try {
      const res = await fetch(`/api/posts/${material.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userStatus: "NEW" }),
      })
      if (!res.ok) throw new Error()
      toast.success("Post restored")
      router.refresh()
    } catch {
      toast.error("Failed to restore post")
    }
  }

  async function handleSendToNotion() {
    setIsSendingToNotion(true)
    try {
      const res = await fetch(`/api/posts/${material.id}/notion`, {
        method: "POST",
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Failed to send to Notion")
      }
      // `truncated`: the page exists, but Notion refused part of the media.
      const result = await res.json().catch(() => ({}))
      if (result.truncated) {
        toast.warning("Sent to Notion — some media could not be attached")
      } else {
        toast.success("Post sent to Notion")
      }
      router.refresh()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to send to Notion"
      )
    } finally {
      setIsSendingToNotion(false)
    }
  }

  const actions: ReadingAction[] = [
    ...baseMaterialActions(material, { onArchive: handleArchive, onRestore: handleRestore }),
    ...(hasNotionIntegration && material.userStatus !== "SENT_TO_NOTION"
      ? [
          {
            key: "notion",
            label: "Send to Notion",
            icon: Send,
            onSelect: handleSendToNotion,
            busy: isSendingToNotion,
          } satisfies ReadingAction,
        ]
      : []),
    {
      key: "delete",
      label: "Delete",
      icon: Trash2,
      onSelect: () => setDeleteDialogOpen(true),
      destructive: true,
    },
  ]

  return (
    <>
      <ReadingShell>
        <MaterialArticle material={material} actions={actions} />
      </ReadingShell>

      <DeleteMaterialDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDelete}
        materialTitle={material.title}
      />
    </>
  )
}
