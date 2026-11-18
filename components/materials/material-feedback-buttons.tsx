"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ThumbsUp, ThumbsDown, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

function SuccessCheck({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-success-check", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="M5 13l4 4L19 7"
        pathLength={1}
        className="animate-success-path"
      />
    </svg>
  )
}

interface MaterialFeedbackButtonsProps {
  materialId: string
  existingFeedback: { feedbackType: "LIKE" | "DISLIKE" } | null
  onFeedbackSubmitted?: (feedbackType: "LIKE" | "DISLIKE") => void
  compact?: boolean
  /** Extra classes on the root — e.g. a negative margin to pull the first
      glyph onto the content grid (cancels the ghost button's inner padding). */
  className?: string
}

export function MaterialFeedbackButtons({
  materialId,
  existingFeedback,
  onFeedbackSubmitted,
  compact = false,
  className,
}: MaterialFeedbackButtonsProps) {
  const [currentFeedback, setCurrentFeedback] = useState<"LIKE" | "DISLIKE" | null>(
    existingFeedback?.feedbackType ?? null
  )
  const [popoverOpen, setPopoverOpen] = useState<"LIKE" | "DISLIKE" | null>(null)
  const [comment, setComment] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showCheck, setShowCheck] = useState(false)
  const dismissTimer = useRef<NodeJS.Timeout | null>(null)
  // Track last confirmed server state for accurate rollback
  const confirmedFeedback = useRef<"LIKE" | "DISLIKE" | null>(existingFeedback?.feedbackType ?? null)
  // Incremented on server success — re-keys the icon-pop animation
  const [confirmedKey, setConfirmedKey] = useState(0)

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
    }
  }, [])

  async function submitFeedback(type: "LIKE" | "DISLIKE", commentText?: string) {
    setIsSubmitting(true)
    setCurrentFeedback(type)

    try {
      const res = await fetch(`/api/posts/${materialId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedbackType: type,
          ...(commentText && { comment: commentText }),
        }),
      })

      if (!res.ok) throw new Error("Failed to save feedback")

      confirmedFeedback.current = type
      setConfirmedKey(k => k + 1)
      onFeedbackSubmitted?.(type)

      setShowCheck(true)
      dismissTimer.current = setTimeout(() => {
        setPopoverOpen(null)
        setShowCheck(false)
        setComment("")
      }, 800)
    } catch {
      // Rollback to last confirmed server state
      setCurrentFeedback(confirmedFeedback.current)
      toast.error("Failed to save feedback")
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleButtonClick(type: "LIKE" | "DISLIKE", e: React.MouseEvent) {
    e.stopPropagation()
    // Only set optimistic state + open popover, don't submit yet
    setCurrentFeedback(type)
    setPopoverOpen(type)
  }

  function handlePopoverClose(type: "LIKE" | "DISLIKE") {
    // When popover closes without comment submission, submit reaction-only
    if (popoverOpen === type && !showCheck) {
      submitFeedback(type)
    }
    setPopoverOpen(null)
    setComment("")
    setShowCheck(false)
  }

  function handleCommentSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!popoverOpen) return
    submitFeedback(popoverOpen, comment.trim() || undefined)
  }

  const isLiked = currentFeedback === "LIKE"
  const isDisliked = currentFeedback === "DISLIKE"

  return (
    <div className={cn("flex items-center gap-1", className)} onClick={(e) => e.stopPropagation()}>
      {/* Like button */}
      <Popover
        open={popoverOpen === "LIKE"}
        onOpenChange={(open) => {
          if (!open) handlePopoverClose("LIKE")
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size={compact ? "icon" : "default"}
            className={cn(
              "h-11 min-w-11 hover:bg-primary-subtle hover:text-primary-subtle-foreground",
              isLiked && "text-primary-subtle-foreground bg-primary-subtle"
            )}
            onClick={(e) => handleButtonClick("LIKE", e)}
            aria-label="Like"
            aria-pressed={isLiked}
          >
            <ThumbsUp key={confirmedKey} className={cn("h-[16px] w-[16px]", isLiked && "fill-current animate-icon-pop")} />
            {!compact && <span className="ml-2">Like</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 relative" side="bottom" align="start">
          <button
            type="button"
            className="absolute right-2 top-2 rounded-sm opacity-70 hover:opacity-100 transition-opacity"
            onClick={() => { setPopoverOpen(null); setComment(""); setShowCheck(false) }}
            aria-label="Close"
          >
            <X className="h-[16px] w-[16px]" />
          </button>
          {showCheck ? (
            <div className="flex items-center justify-center py-3 text-primary">
              <SuccessCheck className="h-[20px] w-[20px] mr-2" />
              <span className="text-sm font-medium animate-count-swap">Saved</span>
            </div>
          ) : (
            <form onSubmit={handleCommentSubmit} className="space-y-3">
              <p className="text-sm text-muted-foreground pr-6">
                Add a comment (optional):
              </p>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="What made this relevant? e.g., 'Practical AI applications with code'"
                rows={2}
                maxLength={500}
                className="resize-none"
                aria-label="Feedback comment"
              />
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground type-counter">{comment.length}/500</span>
                <Button type="submit" className="h-11" disabled={isSubmitting || !comment.trim()}>
                  Save comment
                </Button>
              </div>
            </form>
          )}
        </PopoverContent>
      </Popover>

      {/* Dislike button */}
      <Popover
        open={popoverOpen === "DISLIKE"}
        onOpenChange={(open) => {
          if (!open) handlePopoverClose("DISLIKE")
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size={compact ? "icon" : "default"}
            className={cn(
              "h-11 min-w-11 hover:bg-destructive-subtle hover:text-destructive",
              isDisliked && "text-destructive bg-destructive-subtle"
            )}
            onClick={(e) => handleButtonClick("DISLIKE", e)}
            aria-label="Not relevant"
            aria-pressed={isDisliked}
          >
            <ThumbsDown key={confirmedKey} className={cn("h-[16px] w-[16px]", isDisliked && "fill-current animate-icon-pop")} />
            {!compact && <span className="ml-2">Not relevant</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 relative" side="bottom" align="start">
          <button
            type="button"
            className="absolute right-2 top-2 rounded-sm opacity-70 hover:opacity-100 transition-opacity"
            onClick={() => { setPopoverOpen(null); setComment(""); setShowCheck(false) }}
            aria-label="Close"
          >
            <X className="h-[16px] w-[16px]" />
          </button>
          {showCheck ? (
            <div className="flex items-center justify-center py-3 text-primary">
              <SuccessCheck className="h-[20px] w-[20px] mr-2" />
              <span className="text-sm font-medium animate-count-swap">Saved</span>
            </div>
          ) : (
            <form onSubmit={handleCommentSubmit} className="space-y-3">
              <p className="text-sm text-muted-foreground pr-6">
                Add a comment (optional):
              </p>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Why isn't this relevant? e.g., 'Too basic, already know this'"
                rows={2}
                maxLength={500}
                className="resize-none"
                aria-label="Feedback comment"
              />
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground type-counter">{comment.length}/500</span>
                <Button type="submit" className="h-11" disabled={isSubmitting || !comment.trim()}>
                  Save comment
                </Button>
              </div>
            </form>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
