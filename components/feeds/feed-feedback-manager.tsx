"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MorphText } from "@/components/ui/morph-text"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { ThumbsUp, ThumbsDown, Trash2, Pencil, Check, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

interface Feedback {
  id: string
  feedbackType: "LIKE" | "DISLIKE"
  commentText: string | null
  materialId: string | null
  createdAt: string
  material?: { title: string } | null
}

interface FeedFeedbackManagerProps {
  sourceId: string
}

export function FeedFeedbackManager({ sourceId }: FeedFeedbackManagerProps) {
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([])
  const [stats, setStats] = useState({ likes: 0, dislikes: 0, total: 0 })
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")

  async function fetchFeedbacks() {
    try {
      const res = await fetch(`/api/feeds/${sourceId}/feedback`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setFeedbacks(data.feedbacks)
      setStats(data.stats)
    } catch {
      toast.error("Failed to load feedback")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchFeedbacks()
  }, [sourceId])

  async function handleDelete(id: string) {
    const deletedFeedback = feedbacks.find((f) => f.id === id)
    try {
      const res = await fetch(`/api/feedback/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      setFeedbacks((prev) => prev.filter((f) => f.id !== id))
      setStats((prev) => ({
        ...prev,
        total: prev.total - 1,
        likes: deletedFeedback?.feedbackType === "LIKE" ? prev.likes - 1 : prev.likes,
        dislikes: deletedFeedback?.feedbackType === "DISLIKE" ? prev.dislikes - 1 : prev.dislikes,
      }))
      toast.success("Feedback deleted")
    } catch {
      toast.error("Failed to delete feedback")
    }
  }

  async function handleEdit(id: string) {
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: editText }),
      })
      if (!res.ok) throw new Error()
      setFeedbacks((prev) =>
        prev.map((f) => (f.id === id ? { ...f, commentText: editText } : f))
      )
      setEditingId(null)
      toast.success("Comment updated")
    } catch {
      toast.error("Failed to update comment")
    }
  }

  async function handleResetAll() {
    try {
      const res = await fetch(`/api/feeds/${sourceId}/feedback`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      setFeedbacks([])
      setStats({ likes: 0, dislikes: 0, total: 0 })
      toast.success("All feedback reset")
    } catch {
      toast.error("Failed to reset feedback")
    }
  }

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground text-sm">Loading feedback...</div>
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="flex items-center gap-3">
        <Badge variant="outline" className="gap-1.5">
          <ThumbsUp className="h-[14px] w-[14px] text-primary" />
          <span>
            <MorphText>{stats.likes}</MorphText> likes
          </span>
        </Badge>
        <Badge variant="outline" className="gap-1.5">
          <ThumbsDown className="h-[14px] w-[14px] text-destructive" />
          <span>
            <MorphText>{stats.dislikes}</MorphText> dislikes
          </span>
        </Badge>
        <Badge variant="outline">
          <span>
            <MorphText>{stats.total}</MorphText> total
          </span>
        </Badge>

        {stats.total > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="ml-auto">
                Reset all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all feedback?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all {stats.total} feedback entries for this feed.
                  The AI will lose all learned preferences for this feed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleResetAll}>Reset all</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Feedback list */}
      {feedbacks.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground text-sm">
          No feedback yet. Like or dislike materials to start training the AI.
        </div>
      ) : (
        <div className="space-y-2">
          {feedbacks.map((feedback) => (
            <div
              key={feedback.id}
              className="group flex items-start gap-3 rounded-md p-3 hover:bg-accent/50 transition-colors"
            >
              {/* Icon */}
              {feedback.feedbackType === "LIKE" ? (
                <ThumbsUp className="h-[16px] w-[16px] mt-0.5 text-primary flex-shrink-0" />
              ) : (
                <ThumbsDown className="h-[16px] w-[16px] mt-0.5 text-destructive flex-shrink-0" />
              )}

              {/* Content */}
              <div className="flex-1 min-w-0 space-y-1">
                {editingId === feedback.id ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      maxLength={500}
                      className="h-11"
                      aria-label="Edit feedback comment"
                    />
                    <Button size="icon" variant="ghost" className="h-11 w-11" onClick={() => handleEdit(feedback.id)} aria-label="Save edit">
                      <Check className="h-[16px] w-[16px]" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-11 w-11" onClick={() => setEditingId(null)} aria-label="Cancel edit">
                      <X className="h-[16px] w-[16px]" />
                    </Button>
                  </div>
                ) : (
                  <p className={cn("text-sm", !feedback.commentText && "text-muted-foreground italic")}>
                    {feedback.commentText || "Reaction (no comment)"}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {new Date(feedback.createdAt).toLocaleDateString("en-US")}
                </p>
              </div>

              {/* Actions — always visible on mobile, hover on desktop */}
              {editingId !== feedback.id && (
                <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11"
                    aria-label="Edit comment"
                    onClick={() => {
                      setEditingId(feedback.id)
                      setEditText(feedback.commentText || "")
                    }}
                  >
                    <Pencil className="h-[16px] w-[16px]" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11 text-muted-foreground hover:text-destructive"
                    aria-label="Delete feedback"
                    onClick={() => handleDelete(feedback.id)}
                  >
                    <Trash2 className="h-[16px] w-[16px]" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
