import type { SourceType } from "@prisma/client"

/** A source as the sidebar consumes it (RAD-393 adds `folderId`). */
export type SidebarSource = {
  id: string
  name: string
  type: SourceType
  coverUrl: string | null
  /** Site favicon — preferred icon for the source row when available. */
  faviconUrl: string | null
  /** Materials in the Inbox status (AI-approved, not archived/deleted). */
  inboxCount: number
  /** Folder membership; null = uncategorized. */
  folderId: string | null
}

/** A user-created source folder. Flat — no nesting. */
export type SidebarFolder = {
  id: string
  name: string
}

/** Where a drag can land: a folder id, or null for the Uncategorized bucket. */
export type DropTargetId = string | null
