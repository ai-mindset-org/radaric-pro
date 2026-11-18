"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FEEDBACK_COMMENT_MAX } from "@/lib/validations/feedback"

interface DeleteMaterialDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (feedback?: { sourceFeedback?: string; globalFeedback?: string }) => Promise<void>
  materialTitle: string
  isStory?: boolean
}

export function DeleteMaterialDialog({
  open,
  onOpenChange,
  onConfirm,
  materialTitle,
  isStory = false,
}: DeleteMaterialDialogProps) {
  const [sourceFeedback, setSourceFeedback] = useState("")
  const [globalFeedback, setGlobalFeedback] = useState("")
  const [isDeleting, setIsDeleting] = useState(false)

  async function handleDelete(withFeedback: boolean) {
    setIsDeleting(true)
    try {
      if (withFeedback) {
        await onConfirm({
          sourceFeedback: sourceFeedback.trim() || undefined,
          globalFeedback: globalFeedback.trim() || undefined,
        })
      } else {
        await onConfirm()
      }

      // Reset form
      setSourceFeedback("")
      setGlobalFeedback("")
      onOpenChange(false)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{isStory ? "Delete story and all related posts" : "Delete post and provide AI feedback"}</DialogTitle>
          <DialogDescription>
            {materialTitle}
          </DialogDescription>
        </DialogHeader>

        {!isStory && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sourceFeedback">
                Comment for this feed (optional)
              </Label>
              <Textarea
                id="sourceFeedback"
                placeholder="Explain why this post doesn't fit this particular feed..."
                rows={3}
                maxLength={FEEDBACK_COMMENT_MAX}
                value={sourceFeedback}
                onChange={(e) => setSourceFeedback(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                This comment will be used only for analyzing posts from this feed
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="globalFeedback">
                Global comment for all feeds (optional)
              </Label>
              <Textarea
                id="globalFeedback"
                placeholder="Explain a general criterion applicable to all feeds..."
                rows={3}
                maxLength={FEEDBACK_COMMENT_MAX}
                value={globalFeedback}
                onChange={(e) => setGlobalFeedback(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                This comment will be used for analyzing posts from all feeds
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          {!isStory && (
            <Button
              variant="ghost"
              onClick={() => handleDelete(false)}
              disabled={isDeleting}
            >
              Delete without comment
            </Button>
          )}
          <Button
            variant="destructive-solid"
            onClick={() => handleDelete(isStory ? false : true)}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : isStory ? "Delete story" : "Delete with comment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
