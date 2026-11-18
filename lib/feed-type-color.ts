import type { SourceType } from "@prisma/client"

/**
 * Brand-accent tint classes for a source type. Shared between the sidebar
 * monogram fallback (client) and the per-source hero Badge (server) so the
 * same "colour = source type" vocabulary reads everywhere in the app.
 *
 * Pure function, no React — importable from both server and client modules.
 */
export function typeColorClass(type: SourceType): string {
  switch (type) {
    case "RSS":
      return "bg-orange-500/15 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400"
    case "TELEGRAM":
      return "bg-blue-500/15 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400"
    case "TWITTER":
      // Bumped from zinc-700/400 — zinc-700 on zinc/15 was borderline 5:1
      // (AA passes for 10px font-semibold but thin on real devices).
      return "bg-zinc-500/15 text-zinc-900 dark:bg-zinc-500/20 dark:text-zinc-200"
    case "YOUTUBE":
      // Token idiom, not brand #FF0000 — pure red as text is ~4.0:1 on white
      // (below AA); red-700 on the soft wash passes like its siblings.
      return "bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-400"
    case "INTEREST":
    case "EVENT_TRIGGER":
      return "bg-purple-500/15 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400"
    default:
      return "bg-muted text-muted-foreground"
  }
}
