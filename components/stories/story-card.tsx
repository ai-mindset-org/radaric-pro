"use client"

import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { enUS } from "date-fns/locale"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { CardCover } from "@/components/ui/card-cover"
import { ExternalLink } from "lucide-react"

interface StoryCardProps {
  story: {
    id: string
    title: string
    summary: string
    rubrics: string[]
    sourceUrls: string[]
    notionUrl: string | null
    status: string
    version: number
    createdAt: string
    _count: {
      inboxItems: number
    }
  }
  previewUrl: string | null
  hasNewSources?: boolean
  onView?: () => void
}

const STATUS_STYLES: Record<string, { label: string; variant: "subtle" | "outline" | "destructive" }> = {
  DRAFT: { label: "Draft", variant: "subtle" },
  SENT_TO_NOTION: { label: "In Notion", variant: "outline" },
  ERROR: { label: "Error", variant: "destructive" },
}

export function StoryCard({ story, previewUrl, hasNewSources = false, onView }: StoryCardProps) {
  const statusStyle = STATUS_STYLES[story.status] || STATUS_STYLES.DRAFT
  const domain = story.sourceUrls[0]
    ? (() => { try { return new URL(story.sourceUrls[0]).hostname.replace("www.", "") } catch { return null } })()
    : null

  return (
    <Link href={`/stories/${story.id}`} className="block" onClick={onView}>
      <Card interactive>
        {/* Cover — uncropped, see CardCover */}
        {previewUrl && <CardCover src={previewUrl} alt={story.title} />}

        <CardContent className="p-4 space-y-3">
          {/* Title */}
          <h3 className="font-semibold leading-snug line-clamp-3">
            {story.title}
          </h3>

          {/* Summary */}
          <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">
            {story.summary}
          </p>

          {/* Metadata */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {domain && <span>{domain}</span>}
            {domain && <span>·</span>}
            <span className="flex items-center gap-1">
              {hasNewSources && (
                <span className="h-2 w-2 rounded-full bg-green-bright shrink-0" />
              )}
              {/* One flex item: the gap would otherwise replace the space. */}
              <span><span className="type-counter">{story._count.inboxItems}</span> src.</span>
            </span>
            <span>·</span>
            <span>
              {formatDistanceToNow(new Date(story.createdAt), {
                addSuffix: true,
                locale: enUS,
              })}
            </span>
            {story.version > 1 && (
              <>
                <span>·</span>
                <span className="type-counter">v{story.version}</span>
              </>
            )}
          </div>

          {/* Rubrics */}
          {story.rubrics.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {story.rubrics.map((r) => (
                <Badge key={r} variant="outline" className="text-xs">
                  {r}
                </Badge>
              ))}
            </div>
          )}

          {/* Status + Notion link */}
          <div className="flex items-center justify-between pt-1">
            <Badge variant={statusStyle.variant}>{statusStyle.label}</Badge>
            {story.notionUrl && (
              <a
                href={story.notionUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 py-2 -my-2"
              >
                <ExternalLink className="h-[14px] w-[14px]" />
                Notion
              </a>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
