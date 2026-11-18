import { safeLocalGet, safeLocalSet } from "@/lib/safe-storage"

/**
 * The last finished parse run's result, kept per scope in localStorage
 * (RAD-424) so "5 new posts · checked 3 min ago" outlives the processing card
 * until the next run replaces it. Every access is guarded: storage can be
 * absent (SSR), full, or blocked, and the freshness line must render without it.
 */

export interface LastRun {
  /** ISO time the run finished. */
  at: string
  /** The processing card's "New posts" number for that run. */
  newPosts: number
}

export function lastRunKey(scope: { feedId?: string | null; folderId?: string | null }): string {
  if (scope.feedId) return `radaric:last-run:feed:${scope.feedId}`
  if (scope.folderId) return `radaric:last-run:folder:${scope.folderId}`
  return "radaric:last-run:all"
}

function isLastRun(value: unknown): value is LastRun {
  if (typeof value !== "object" || value === null) return false
  const { at, newPosts } = value as Record<string, unknown>
  return (
    typeof at === "string" &&
    !Number.isNaN(new Date(at).getTime()) &&
    typeof newPosts === "number" &&
    Number.isInteger(newPosts) &&
    newPosts >= 0
  )
}

export function readLastRun(key: string): LastRun | null {
  const raw = safeLocalGet(key)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLastRun(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeLastRun(key: string, run: LastRun): void {
  safeLocalSet(key, JSON.stringify(run))
}
