"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Check, MoreHorizontal } from "lucide-react"
import { useDraggable } from "@dnd-kit/core"
import type { SidebarSource } from "./sidebar-types"
import { useSidebarTree } from "./sidebar-tree-provider"
import { cn } from "@/lib/utils"
import { typeColorClass } from "@/lib/feed-type-color"
import { MorphText } from "@/components/ui/morph-text"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * One source row: the existing link + cover + inbox badge, plus drag support
 * and the kebab menu (RAD-393).
 *
 * The menu is the canonical move path — keyboard, touch and discoverability —
 * and every drag outcome has an exact menu equivalent (`Move to folder…`,
 * `Remove from folder`). The drag is pointer/touch only on purpose: dnd-kit's
 * keyboard sensor would bind Space/Enter, which must keep navigating the link.
 */
export function SidebarSourceRow({
  source,
  instanceId,
  count,
  inFolder = false,
}: {
  source: SidebarSource
  instanceId: string
  count: number
  inFolder?: boolean
}) {
  const pathname = usePathname()
  const { folders, moveSource, startCreating, reveal, flashElementId } = useSidebarTree()
  // Two paths move focus themselves and must stop Radix's close-auto-focus
  // from competing on the same tick: "New folder…" spawns an editor that
  // autofocuses (its empty-blur would cancel creation), and a successful
  // move's reveal() focuses the moved row.
  const skipFocusRestoreRef = useRef(false)
  const active = pathname === `/feeds/${source.id}`
  const rowElementId = `${instanceId}-source-${source.id}`
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${instanceId}-drag-${source.id}`,
    data: { sourceId: source.id },
  })

  /** Move + reveal (focus, scroll, flash) on success — menu path. */
  async function moveTo(targetFolderId: string | null) {
    const moved = await moveSource(source.id, targetFolderId)
    if (moved) {
      skipFocusRestoreRef.current = true
      reveal(rowElementId)
    }
  }

  return (
    <li
      ref={setNodeRef}
      {...listeners}
      // touch-action: manipulation is what lets the long-press TouchSensor win
      // before the browser claims the gesture for scrolling (dnd-kit requirement
      // for touch draggables).
      className={cn("group/source relative touch-manipulation", inFolder && "pl-5", isDragging && "opacity-40")}
    >
      <Link
        id={rowElementId}
        href={`/feeds/${source.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex items-center gap-2.5 h-11 pl-3 pr-8 rounded-md text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-inset",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
          flashElementId === rowElementId && "bg-primary-subtle text-primary-subtle-foreground"
        )}
      >
        <SourceCover source={source} />
        <span className="flex-1 truncate">{source.name}</span>
        {count > 0 && (
          <span
            className="shrink-0 type-counter text-xs font-medium text-muted-foreground"
            aria-label={`${count} in inbox`}
          >
            <MorphText timing="fast">{count}</MorphText>
          </span>
        )}
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${source.name}`}
            // The row is the draggable; opening the menu must never pick it up.
            onPointerDown={event => event.stopPropagation()}
            className={cn(
              "absolute right-1 top-1/2 flex h-8 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground",
              "opacity-0 transition-opacity group-hover/source:opacity-100 group-focus-within/source:opacity-100",
              "[@media(hover:none)]:h-11 [@media(hover:none)]:w-11 [@media(hover:none)]:opacity-100",
              "hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
            )}
          >
            <MoreHorizontal className="h-[15px] w-[15px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-52"
          onCloseAutoFocus={event => {
            if (!skipFocusRestoreRef.current) return
            skipFocusRestoreRef.current = false
            event.preventDefault()
          }}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to folder</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto scrollbar-stable">
              {folders.map(folder => (
                <DropdownMenuItem
                  key={folder.id}
                  disabled={folder.id === source.folderId}
                  onSelect={() => void moveTo(folder.id)}
                >
                  <span className="mr-2 flex h-4 w-4 items-center justify-center">
                    {folder.id === source.folderId && <Check className="h-4 w-4" />}
                  </span>
                  <span className="truncate">{folder.name}</span>
                </DropdownMenuItem>
              ))}
              {folders.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={() => {
                  skipFocusRestoreRef.current = true
                  startCreating(source.id)
                }}
              >
                New folder…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {source.folderId && (
            <DropdownMenuItem onSelect={() => void moveTo(null)}>
              Remove from folder
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export function SourceCover({ source }: { source: SidebarSource }) {
  const [errored, setErrored] = useState(false)
  // Prefer the site favicon (crisp at 24px); fall back to the cover/avatar,
  // then to a type-tinted monogram when neither exists or the image fails.
  const imgSrc = source.faviconUrl ?? source.coverUrl
  const showFallback = !imgSrc || errored

  if (showFallback) {
    return (
      <div
        className={cn(
          "icon-tile h-6 w-6 flex items-center justify-center text-[10px] font-semibold uppercase shrink-0",
          typeColorClass(source.type)
        )}
        style={{ "--tile-size": "1.5rem" } as React.CSSProperties}
      >
        {source.name.slice(0, 1)}
      </div>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- 24px favicon, external URLs, not worth next/image overhead
    <img
      src={imgSrc}
      alt=""
      className="icon-tile h-6 w-6 object-cover shrink-0"
      style={{ "--tile-size": "1.5rem" } as React.CSSProperties}
      onError={() => setErrored(true)}
    />
  )
}
