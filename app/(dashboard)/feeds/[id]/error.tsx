"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function FeedErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <h2 className="text-xl font-semibold tracking-tight">Something went wrong</h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        We couldn&apos;t load this source. Try again, or head back to your posts.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs text-muted-foreground font-mono">Ref: {error.digest}</p>
      )}
      <div className="mt-6 flex items-center gap-2">
        <Button onClick={() => reset()} variant="outline" size="sm">
          Try again
        </Button>
        <Button asChild size="sm">
          <Link href="/posts">Back to Posts</Link>
        </Button>
      </div>
    </div>
  )
}
