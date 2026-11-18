"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ExternalLink, Trash2, CheckCircle, XCircle, Archive, ArchiveRestore } from "lucide-react"
import { format } from "date-fns"
import { enUS } from "date-fns/locale"
import { DeleteMaterialDialog } from "./delete-material-dialog"
import { convertTelegramEntitiesToReact, type TelegramEntity } from "@/lib/telegram-entities-to-react"
import { MaterialFeedbackButtons } from "./material-feedback-buttons"
import { isHtml } from "@/lib/html-utils"
import { sanitizeHtml } from "@/lib/sanitize"

interface MaterialDetailDialogProps {
  material: {
    id: string
    title: string
    url: string
    content: string
    contentEntities?: TelegramEntity[] | null
    publishedAt: Date | null
    thumbnailUrl?: string | null
    mediaUrls?: string[]
    aiEvaluation: "APPROVED" | "FILTERED"
    aiConfidence: number
    aiReasoning: string | null
    userStatus: "NEW" | "READ" | "SENT_TO_NOTION" | "DELETED" | "ARCHIVED" | "SENT_TO_STORIES"
    feed: {
      id: string
      name: string
      type: "RSS" | "TELEGRAM" | "TWITTER" | "YOUTUBE" | "INTEREST" | "EVENT_TRIGGER"
    }
    feedbacks?: Array<{ feedbackType: "LIKE" | "DISLIKE" }>
  } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete?: (id: string, feedback?: { sourceFeedback?: string; globalFeedback?: string }) => Promise<void>
  onArchive?: (id: string) => Promise<void>
  onRestore?: (id: string) => Promise<void>
}

export function MaterialDetailDialog({
  material,
  open,
  onOpenChange,
  onDelete,
  onArchive,
  onRestore,
}: MaterialDetailDialogProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  if (!material) return null

  async function handleDelete(feedback?: { sourceFeedback?: string; globalFeedback?: string }) {
    if (!onDelete || !material) return
    await onDelete(material.id, feedback)
    onOpenChange(false)
  }

  async function handleArchive() {
    if (!onArchive || !material) return
    await onArchive(material.id)
    onOpenChange(false)
  }

  async function handleRestore() {
    if (!onRestore || !material) return
    await onRestore(material.id)
    onOpenChange(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[800px] max-h-[90vh] flex flex-col p-[32px]">
          <DialogHeader>
            <div className="space-y-3">
              {/* Badges */}
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    material.aiEvaluation === "APPROVED" ? "default" : "secondary"
                  }
                >
                  {material.aiEvaluation === "APPROVED" ? (
                    <CheckCircle className="mr-1 h-[14px] w-[14px]" />
                  ) : (
                    <XCircle className="mr-1 h-[14px] w-[14px]" />
                  )}
                  {material.aiEvaluation === "APPROVED" ? "AI Approved" : "AI Filtered"}
                </Badge>

                <Badge variant="outline">
                  Confidence: {material.aiConfidence}%
                </Badge>

                {material.userStatus === "SENT_TO_NOTION" && (
                  <Badge variant="outline">Sent to Notion</Badge>
                )}

                {material.userStatus === "SENT_TO_STORIES" && (
                  <Badge variant="outline">In Stories</Badge>
                )}
              </div>

              {/* Title */}
              <DialogTitle className="text-2xl">{material.title}</DialogTitle>

              {/* Metadata */}
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="font-medium">{material.feed.name}</span>
                {material.publishedAt && (
                  <>
                    <span>•</span>
                    <span>
                      {format(new Date(material.publishedAt), "d MMMM yyyy, HH:mm", {
                        locale: enUS,
                      })}
                    </span>
                  </>
                )}
              </div>

              {/* Feedback */}
              <MaterialFeedbackButtons
                materialId={material.id}
                existingFeedback={material.feedbacks?.[0] ?? null}
              />

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Button variant="outline" asChild>
                  <a
                    href={material.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="mr-2 h-[16px] w-[16px]" />
                    Open original
                  </a>
                </Button>

                {material.userStatus === "ARCHIVED" ? (
                  <Button onClick={handleRestore}>
                    <ArchiveRestore className="mr-2 h-[16px] w-[16px]" />
                    Restore from archive
                  </Button>
                ) : (
                  <Button variant="outline" onClick={handleArchive}>
                    <Archive className="mr-2 h-[16px] w-[16px]" />
                    Archive
                  </Button>
                )}


                <Button
                  variant="destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="mr-2 h-[16px] w-[16px]" />
                  Delete
                </Button>
              </div>
            </div>
          </DialogHeader>

          <Separator className="flex-shrink-0" />

          {/* Scrollable content container */}
          <div className="overflow-y-auto flex-1 min-h-0 space-y-4 pr-1">
            {/* Media Gallery */}
            {material.mediaUrls && material.mediaUrls.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-semibold text-sm">Media ({material.mediaUrls.length})</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {material.mediaUrls.map((mediaUrl, index) => {
                    // Validate video embed URLs by hostname (not just substring)
                    const validVideoHosts = ['youtube.com', 'www.youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com']
                    let isValidVideoUrl = false
                    try {
                      const hostname = new URL(mediaUrl).hostname
                      isValidVideoUrl = validVideoHosts.includes(hostname)
                    } catch {
                      // Invalid URL, not a video
                    }

                    return (
                    <div key={index} className="relative rounded-lg overflow-hidden bg-muted">
                      {/* Check if it's a valid video URL from trusted hosts */}
                      {isValidVideoUrl ? (
                        <div className="aspect-video">
                          <iframe
                            src={mediaUrl}
                            className="w-full h-full"
                            allowFullScreen
                            sandbox="allow-scripts allow-same-origin allow-presentation"
                            title={`Video ${index + 1}`}
                          />
                        </div>
                      ) : mediaUrl.startsWith("tg://") ? (
                        // Telegram media placeholder
                        <div className="aspect-video flex items-center justify-center bg-muted">
                          <p className="text-sm text-muted-foreground">Telegram media</p>
                        </div>
                      ) : (
                        // Regular image
                        <img
                          src={mediaUrl}
                          alt={`Media ${index + 1}`}
                          className="w-full h-auto object-contain max-h-96"
                          onError={(e) => {
                            e.currentTarget.style.display = "none"
                          }}
                        />
                      )}
                    </div>
                  )})}

                </div>
                <Separator />
              </div>
            )}

            {/* Content */}
            <div className="space-y-4">

              <div className="prose prose-sm max-w-none dark:prose-invert [&_a]:link">
                {material.contentEntities && material.contentEntities.length > 0 ? (
                  <div className="whitespace-pre-wrap">
                    {convertTelegramEntitiesToReact(material.content, material.contentEntities, "full")}
                  </div>
                ) : isHtml(material.content) ? (
                  <div
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(material.content) }}
                  />
                ) : (
                  <p className="whitespace-pre-wrap">{material.content}</p>
                )}
              </div>

              {/* AI Reasoning */}
              {material.aiReasoning && (
                <>
                  <Separator />
                  <div className="rounded-lg bg-muted p-4">
                    <h4 className="font-semibold mb-2">AI Reasoning:</h4>
                    <p className="text-sm text-muted-foreground">
                      {material.aiReasoning}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <DeleteMaterialDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDelete}
        materialTitle={material.title}
      />
    </>
  )
}
