"use client"

/**
 * The two empty states a peek can be in (RAD-345), shared by both kinds:
 * a quiet skeleton while the fetch is in flight, and a message that says what
 * happened and what to do next — transport failure with a retry, or "gone" with
 * only a close.
 */

import { Button } from "@/components/ui/button"

export function PeekNotice({
  title,
  body,
  onRetry,
  onClose,
}: {
  title: string
  body: string
  onRetry?: () => void
  onClose: () => void
}) {
  return (
    <div className="mt-10 flex flex-col items-start gap-4" role="status">
      <div className="space-y-1.5">
        <p className="type-heading text-base font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
      </div>
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}

/** A quiet skeleton shaped like the article it is replacing. */
export function PeekSkeleton({ label }: { label: string }) {
  return (
    <div className="mt-6 space-y-4" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="flex items-center justify-between">
        <div className="h-3 w-24 rounded-xs bg-muted animate-pulse" aria-hidden="true" />
        <div className="h-3 w-10 rounded-xs bg-muted animate-pulse" aria-hidden="true" />
      </div>
      <div className="h-7 w-4/5 rounded-sm bg-muted animate-pulse" aria-hidden="true" />
      <div className="h-3 w-40 rounded-xs bg-muted animate-pulse" aria-hidden="true" />
      <div className="space-y-2 pt-2">
        <div className="h-3 w-full rounded-xs bg-muted animate-pulse" aria-hidden="true" />
        <div className="h-3 w-full rounded-xs bg-muted animate-pulse" aria-hidden="true" />
        <div className="h-3 w-3/5 rounded-xs bg-muted animate-pulse" aria-hidden="true" />
      </div>
    </div>
  )
}
