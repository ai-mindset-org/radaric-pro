"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Inbox, Plus } from "lucide-react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { cn } from "@/lib/utils"
import type { SidebarSource } from "./sidebar-types"
import { useSidebarTree } from "./sidebar-tree-provider"
import { SidebarFolderRow } from "./sidebar-folder-row"
import { SidebarNameInput } from "./sidebar-name-input"
import { SidebarSourceRow, SourceCover } from "./sidebar-source-row"

export type { SidebarSource, SidebarFolder } from "./sidebar-types"

type SidebarProps = {
  /**
   * Stable per-instance key for DOM ids and dnd ids. Both instances (desktop
   * aside + mobile Sheet) can be mounted at once; namespace every id or the
   * droppables collide.
   */
  instanceId: "desktop" | "mobile"
  /**
   * DOM id of the nav element. Needed when multiple Sidebar instances are
   * rendered (desktop aside + mobile Sheet) to keep the aria-controls
   * targets unique.
   */
  id?: string
  /**
   * Live per-source Inbox counts (from /api/stats) keyed by source id. When
   * present, overrides the SSR count so the badge updates instantly after a
   * material action without a full reload.
   */
  liveCounts?: Record<string, number>
}

export function Sidebar({ instanceId, id, liveCounts }: SidebarProps) {
  const pathname = usePathname()
  const {
    folders,
    sources,
    isCreating,
    startCreating,
    cancelCreating,
    createFolder,
    moveSource,
    expandFolder,
    pendingMoveSourceId,
    reveal,
  } = useSidebarTree()
  const [activeDrag, setActiveDrag] = useState<{ source: SidebarSource; width: number } | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // 450ms long-press: scrolling a touch list must never pick a row up.
    useSensor(TouchSensor, { activationConstraint: { delay: 450, tolerance: 8 } })
  )

  const membersByFolder = useMemo(() => {
    const knownFolderIds = new Set(folders.map(folder => folder.id))
    const map = new Map<string | null, SidebarSource[]>()
    for (const source of sources) {
      // A source pointing at a folder that no longer exists (a transient state
      // between an optimistic delete and the server payload) belongs in
      // Uncategorized rather than rendering nowhere.
      const key = source.folderId && knownFolderIds.has(source.folderId) ? source.folderId : null
      const list = map.get(key) ?? []
      list.push(source)
      map.set(key, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [folders, sources])

  const countOf = (source: SidebarSource) => liveCounts?.[source.id] ?? source.inboxCount
  const activeSourceFolderId = activeDrag ? activeDrag.source.folderId : undefined
  const uncategorized = membersByFolder.get(null) ?? []

  function handleDragStart(event: DragStartEvent) {
    const sourceId = (event.active.data.current as { sourceId?: string } | undefined)?.sourceId
    const source = sources.find(candidate => candidate.id === sourceId)
    if (!source) return
    // The overlay matches the dragged row's measured width (sidebar widths
    // differ between the desktop aside and the mobile drawer).
    const width = event.active.rect.current.initial?.width ?? 240
    setActiveDrag({ source, width })
  }

  async function handleDragEnd(event: DragEndEvent) {
    const drag = activeDrag
    setActiveDrag(null)
    if (!drag) return
    const data = event.over?.data.current as { folderId?: string | null } | undefined
    if (!data || !("folderId" in data)) return
    const targetFolderId = data.folderId ?? null
    // Re-read the live source: a background refresh mid-drag must not make the
    // no-op guard disagree with what moveSource will actually do.
    const live = sources.find(candidate => candidate.id === drag.source.id) ?? drag.source
    if (live.folderId === targetFolderId) return

    // A collapsed target expands so the result is visible.
    if (targetFolderId) expandFolder(targetFolderId)
    const moved = await moveSource(live.id, targetFolderId)
    if (moved) reveal(`${instanceId}-source-${live.id}`)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={event => void handleDragEnd(event)}
      onDragCancel={() => setActiveDrag(null)}
    >
      <nav
        id={id}
        aria-label="Sources and folders"
        className="h-full w-full bg-sidebar flex flex-col"
      >
        <div className="px-3 pt-3 pb-2 shrink-0">
          <SidebarLink
            href="/posts"
            active={pathname === "/posts"}
            icon={
              <div
                className="icon-tile h-6 w-6 flex items-center justify-center bg-primary-subtle text-primary-subtle-foreground shrink-0"
                style={{ "--tile-size": "1.5rem" } as React.CSSProperties}
              >
                <Inbox className="h-[14px] w-[14px]" />
              </div>
            }
            label="All"
          />
        </div>

        {/* One scroll region for folders + uncategorized: a long folder list
            must never push the bucket out of reach. */}
        <div className="flex-1 overflow-y-auto scrollbar-none px-3 pb-3">
          <div className="flex items-center justify-between pt-3 pb-1">
            <span className="type-tag text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Folders
            </span>
            <button
              type="button"
              aria-label={isCreating ? "Cancel new folder" : "New folder"}
              onClick={() => (isCreating ? cancelCreating() : startCreating())}
              onPointerDown={event => event.stopPropagation()}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground",
                "hover:bg-sidebar-accent/50 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55",
                "[@media(hover:none)]:h-11 [@media(hover:none)]:w-11"
              )}
            >
              <Plus className="h-[14px] w-[14px]" aria-hidden="true" />
            </button>
          </div>

          <ul role="list" className="space-y-0.5">
            {folders.map(folder => {
              const members = membersByFolder.get(folder.id) ?? []
              const count = members.reduce((total, source) => total + countOf(source), 0)
              return (
                <SidebarFolderRow
                  key={folder.id}
                  folder={folder}
                  members={members}
                  count={count}
                  instanceId={instanceId}
                  liveCounts={liveCounts}
                  activeSourceFolderId={activeSourceFolderId}
                />
              )
            })}

            {isCreating && (
              <li className="flex items-center px-3">
                <SidebarNameInput
                  ariaLabel="Folder name"
                  failureMessage="Couldn’t create the folder — try again."
                  onCommit={async name => {
                    const result = await createFolder(name)
                    if (result.ok) {
                      const focusId = pendingMoveSourceId
                        ? `${instanceId}-source-${pendingMoveSourceId}`
                        : `${instanceId}-folder-${result.id}`
                      cancelCreating()
                      reveal(focusId)
                    }
                    return result
                  }}
                  onCancel={cancelCreating}
                  className="py-1"
                />
              </li>
            )}
          </ul>

          {folders.length === 0 && sources.length > 0 && (
            <div className="type-tag px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sources
            </div>
          )}

          {folders.length > 0 ? (
            <UncategorizedSection
              sources={uncategorized}
              liveCounts={liveCounts}
              instanceId={instanceId}
              activeSourceFolderId={activeSourceFolderId}
            />
          ) : (
            <ul role="list" className="space-y-0.5">
              {uncategorized.map(source => (
                <SidebarSourceRow
                  key={source.id}
                  source={source}
                  instanceId={instanceId}
                  count={countOf(source)}
                />
              ))}
            </ul>
          )}
        </div>
      </nav>

      <DragOverlay dropAnimation={null}>
        {activeDrag && (
          <div
            style={{ width: activeDrag.width }}
            className="flex h-11 items-center gap-2.5 rounded-md bg-sidebar-accent px-3 text-sm font-medium text-sidebar-accent-foreground shadow-lg"
          >
            <SourceCover source={activeDrag.source} />
            <span className="flex-1 truncate">{activeDrag.source.name}</span>
            {countOf(activeDrag.source) > 0 && (
              <span className="type-counter text-xs">{countOf(activeDrag.source)}</span>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

/**
 * The uncategorized bucket (RAD-393): the unfile target. It renders whenever a
 * folder exists — an empty bucket keeps a slim hint row so it reads as a place,
 * not a rendering bug, and doubles as the "Remove from folder" drop zone.
 */
function UncategorizedSection({
  sources,
  liveCounts,
  instanceId,
  activeSourceFolderId,
}: {
  sources: SidebarSource[]
  liveCounts?: Record<string, number>
  instanceId: string
  activeSourceFolderId?: string | null
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${instanceId}-uncategorized-drop`,
    data: { folderId: null },
  })
  // Only a foldered source can land here; an already-uncategorized row would
  // be a no-op, so no highlight.
  const highlighted = isOver && activeSourceFolderId != null

  return (
    <div
      ref={setNodeRef}
      className={cn("rounded-md", highlighted && "bg-sidebar-accent/60 ring-1 ring-inset ring-ring/40")}
    >
      <div className="type-tag px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Uncategorized
      </div>
      {sources.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">
          {highlighted ? "Remove from folder" : "No uncategorized sources"}
        </p>
      ) : (
        <ul role="list" className="space-y-0.5">
          {sources.map(source => (
            <SidebarSourceRow
              key={source.id}
              source={source}
              instanceId={instanceId}
              count={liveCounts?.[source.id] ?? source.inboxCount}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function SidebarLink({
  href,
  active,
  icon,
  label,
  count,
}: {
  href: string
  active: boolean
  icon: React.ReactNode
  label: string
  count?: number
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Uniform font weight across active + inactive rows (no layout jiggle
        // on selection) — Feedly / Linear pattern: background changes, weight
        // stays put.
        "relative flex items-center gap-2.5 h-11 px-3 rounded-md text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-inset",
        // Selected state: green-tonal background fill, no leading-edge bar.
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className="shrink-0 type-counter text-xs font-medium text-muted-foreground"
          aria-label={`${count} in inbox`}
        >
          {count}
        </span>
      )}
    </Link>
  )
}
