import { Folder as FolderIcon } from "lucide-react"

/**
 * The `/folders/[id]` empty state for a folder with no visible sources
 * (RAD-393). The folder itself is not a drop target in v1 — the sidebar is —
 * so the copy points there.
 */
export function FolderEmptyState({ name }: { name: string }) {
  return (
    <div className="p-4 lg:p-8 space-y-6">
      <div className="mt-2 flex items-center gap-3 lg:mt-4">
        <div
          className="icon-tile flex h-12 w-12 shrink-0 items-center justify-center bg-secondary"
          style={{ "--tile-size": "3rem" } as React.CSSProperties}
        >
          <FolderIcon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 className="min-w-0 truncate text-xl font-bold md:text-2xl" title={name}>
          {name}
        </h1>
      </div>

      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-hairline px-6 py-16 text-center">
        <FolderIcon className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">This folder is empty</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Drag sources into it from the sidebar — or use “Move to folder” on any source.
        </p>
      </div>
    </div>
  )
}
