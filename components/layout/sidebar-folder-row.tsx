"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight, MoreHorizontal } from "lucide-react"
import { useDroppable } from "@dnd-kit/core"
import type { SidebarFolder, SidebarSource } from "./sidebar-types"
import { useSidebarTree } from "./sidebar-tree-provider"
import { SidebarNameInput } from "./sidebar-name-input"
import { SidebarSourceRow } from "./sidebar-source-row"
import { cn } from "@/lib/utils"
import { MorphText } from "@/components/ui/morph-text"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * One folder row + its members (RAD-393).
 *
 * Name click opens the folder (the brief's primary action); the chevron is a
 * separate expand control. The row + children form one drop target, so a
 * pointer anywhere over the folder files the dragged source into it.
 */
export function SidebarFolderRow({
  folder,
  members,
  count,
  instanceId,
  liveCounts,
  activeSourceFolderId,
}: {
  folder: SidebarFolder
  members: SidebarSource[]
  count: number
  instanceId: string
  liveCounts?: Record<string, number>
  /** The dragged source's current folder; undefined when nothing is dragging. */
  activeSourceFolderId?: string | null
}) {
  const pathname = usePathname()
  const { isExpanded, toggleFolder, renameFolder, deleteFolder, reveal, flashElementId } = useSidebarTree()
  const [renaming, setRenaming] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const expanded = isExpanded(folder.id)
  const active = pathname === `/folders/${folder.id}`
  const childrenId = `${instanceId}-folder-${folder.id}-sources`
  const folderElementId = `${instanceId}-folder-${folder.id}`

  const { setNodeRef, isOver } = useDroppable({
    id: `${instanceId}-folder-drop-${folder.id}`,
    data: { folderId: folder.id },
  })
  // The folder a source is already in is not a target — dropping there is a
  // no-op, and a highlight would promise otherwise.
  const highlighted = isOver && activeSourceFolderId !== folder.id

  const deleteBody =
    members.length === 0
      ? "This folder is empty. Nothing else changes."
      : members.length === 1
        ? "1 source will move back to Uncategorized. No sources or materials are deleted."
        : `${members.length} sources will move back to Uncategorized. No sources or materials are deleted.`

  return (
    <li
      ref={setNodeRef}
      className={cn(
        "rounded-md",
        highlighted && "bg-sidebar-accent/60 ring-1 ring-inset ring-ring/40"
      )}
    >
      <div className="group/folder relative flex items-center">
        <button
          type="button"
          aria-label={expanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
          aria-expanded={expanded}
          aria-controls={childrenId}
          onClick={() => toggleFolder(folder.id)}
          className={cn(
            "flex h-11 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground",
            "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
          )}
        >
          <ChevronRight
            className={cn("h-4 w-4 transition-transform duration-150 motion-reduce:transition-none", expanded && "rotate-90")}
            aria-hidden="true"
          />
        </button>

        {renaming ? (
          <SidebarNameInput
            defaultValue={folder.name}
            ariaLabel={`Folder name for ${folder.name}`}
            failureMessage="Couldn’t rename the folder — try again."
            onCommit={async name => {
              const result = await renameFolder(folder.id, name)
              if (result.ok) {
                setRenaming(false)
                reveal(folderElementId)
              }
              return result
            }}
            onCancel={() => setRenaming(false)}
            className="py-1"
          />
        ) : (
          <Link
            id={folderElementId}
            href={`/folders/${folder.id}`}
            aria-current={active ? "page" : undefined}
            title={`Open ${folder.name}`}
            className={cn(
              "relative flex h-11 min-w-0 flex-1 items-center gap-2.5 pr-8 text-sm font-medium transition-colors",
              "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-inset",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              flashElementId === folderElementId && "bg-primary-subtle text-primary-subtle-foreground"
            )}
          >
            <span className="flex-1 truncate">{folder.name}</span>
            {count > 0 && (
              <span
                className="shrink-0 type-counter text-xs font-medium text-muted-foreground"
                aria-label={`${count} in inbox`}
              >
                <MorphText timing="fast">{count}</MorphText>
              </span>
            )}
          </Link>
        )}

        {!renaming && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${folder.name}`}
                className={cn(
                  "absolute right-1 top-1/2 flex h-8 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground",
                  "opacity-0 transition-opacity group-hover/folder:opacity-100 group-focus-within/folder:opacity-100",
                  "[@media(hover:none)]:h-11 [@media(hover:none)]:w-11 [@media(hover:none)]:opacity-100",
                  "hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
                )}
              >
                <MoreHorizontal className="h-[15px] w-[15px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConfirmOpen(true)}
                className="text-destructive"
              >
                Delete folder…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {expanded && members.length > 0 && (
        <ul id={childrenId} role="list" className="mt-0.5 space-y-0.5">
          {members.map(source => (
            <SidebarSourceRow
              key={source.id}
              source={source}
              instanceId={instanceId}
              count={liveCounts?.[source.id] ?? source.inboxCount}
              inFolder
            />
          ))}
        </ul>
      )}
      {expanded && members.length === 0 && <ul id={childrenId} role="list" />}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder “{folder.name}”?</AlertDialogTitle>
            <AlertDialogDescription>{deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void deleteFolder(folder.id)}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
