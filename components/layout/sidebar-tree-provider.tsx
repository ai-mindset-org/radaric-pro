"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import { persistUiState } from "@/lib/ui-state"
import type { SidebarFolder, SidebarSource } from "./sidebar-types"

export type FolderResult = { ok: true; id: string } | { ok: false; error: "duplicate" | "failed" }

type SidebarTreeContextValue = {
  folders: SidebarFolder[]
  sources: SidebarSource[]
  collapsed: Set<string>
  isCreating: boolean
  pendingMoveSourceId: string | null
  /** The DOM id of the element that should flash after a create/move/rename. */
  flashElementId: string | null
  startCreating: (moveSourceId?: string) => void
  cancelCreating: () => void
  createFolder: (name: string) => Promise<FolderResult>
  renameFolder: (id: string, name: string) => Promise<FolderResult>
  deleteFolder: (id: string) => Promise<boolean>
  moveSource: (sourceId: string, folderId: string | null) => Promise<boolean>
  toggleFolder: (id: string) => void
  expandFolder: (id: string) => void
  isExpanded: (id: string) => boolean
  /** Scroll the element into view, focus it, and flash it briefly. */
  reveal: (elementId: string) => void
}

const SidebarTreeContext = createContext<SidebarTreeContextValue | null>(null)

export function useSidebarTree(): SidebarTreeContextValue {
  const context = useContext(SidebarTreeContext)
  if (!context) throw new Error("useSidebarTree must be used within SidebarTreeProvider")
  return context
}

const byName = (a: SidebarFolder, b: SidebarFolder) => a.name.localeCompare(b.name)

/**
 * Owns the sidebar tree for both mounted Sidebar instances (desktop aside +
 * mobile Sheet) — one state, one set of optimistic mutations (RAD-393).
 *
 * Reconciliation: fresh server props replace local state only when no
 * mutation is in flight. Mutations update the tree optimistically and the
 * server revalidates the layout (`revalidatePath`) — move/create/delete do NOT
 * call `router.refresh()`, because a refresh issued by an earlier mutation can
 * land after a later one and overwrite its optimistic state. Rename refreshes
 * on purpose: the open folder page's heading must update immediately.
 */
export function SidebarTreeProvider({
  folders: initialFolders,
  sources: initialSources,
  collapsed: initialCollapsed,
  children,
}: {
  folders: SidebarFolder[]
  sources: SidebarSource[]
  collapsed: string[]
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [folders, setFolders] = useState(initialFolders)
  const [sources, setSources] = useState(initialSources)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initialCollapsed))
  const [isCreating, setIsCreating] = useState(false)
  const [pendingMoveSourceId, setPendingMoveSourceId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [flashElementId, setFlashElementId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pendingRef = useRef(0)
  const foldersRef = useRef(folders)
  const sourcesRef = useRef(sources)
  const collapsedRef = useRef(collapsed)
  const pendingMoveSourceIdRef = useRef<string | null>(null)

  useEffect(() => {
    foldersRef.current = folders
    sourcesRef.current = sources
    collapsedRef.current = collapsed
  })

  useEffect(() => {
    if (pendingRef.current > 0) return
    setFolders(initialFolders)
    setSources(initialSources)
  }, [initialFolders, initialSources])

  // A source page whose folder is collapsed still shows its row: expansion is
  // transient for the visit and never written over the user's own collapse.
  const activeFolderId = useMemo(() => {
    const active = sources.find(source => pathname === `/feeds/${source.id}`)
    return active?.folderId ?? null
  }, [sources, pathname])

  const isExpanded = useCallback(
    (id: string) => !collapsed.has(id) || activeFolderId === id,
    [collapsed, activeFolderId]
  )

  const persistCollapsed = useCallback((next: Set<string>) => {
    // Fire-and-forget; a failed write costs one expand state, never correctness.
    persistUiState({ collapsedFolders: [...next] })
  }, [])

  const toggleFolder = useCallback(
    (id: string) => {
      const next = new Set(collapsedRef.current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      collapsedRef.current = next
      setCollapsed(next)
      persistCollapsed(next)
    },
    [persistCollapsed]
  )

  const expandFolder = useCallback(
    (id: string) => {
      if (!collapsedRef.current.has(id)) return
      const next = new Set(collapsedRef.current)
      next.delete(id)
      collapsedRef.current = next
      setCollapsed(next)
      persistCollapsed(next)
    },
    [persistCollapsed]
  )

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    }
  }, [])

  /**
   * The shared post-mutation affordance: scroll the affected row into view,
   * focus it (keyboard continuity even for pointer drags), flash it. Safe to
   * call immediately after a successful mutation — the rAF runs after the
   * state commit that rendered the row at its new position.
   */
  const reveal = useCallback((elementId: string) => {
    requestAnimationFrame(() => {
      const element = document.getElementById(elementId)
      element?.scrollIntoView({ block: "nearest" })
      element?.focus()
    })
    setFlashElementId(elementId)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashElementId(null), 1200)
  }, [])

  const startCreating = useCallback((moveSourceId?: string) => {
    pendingMoveSourceIdRef.current = moveSourceId ?? null
    setPendingMoveSourceId(moveSourceId ?? null)
    setIsCreating(true)
  }, [])

  const cancelCreating = useCallback(() => {
    pendingMoveSourceIdRef.current = null
    setPendingMoveSourceId(null)
    setIsCreating(false)
  }, [])

  const moveSource = useCallback(
    async (sourceId: string, folderId: string | null): Promise<boolean> => {
      const snapshot = sourcesRef.current
      const source = snapshot.find(candidate => candidate.id === sourceId)
      if (!source || source.folderId === folderId) return true
      const previousFolderName = source.folderId
        ? (foldersRef.current.find(folder => folder.id === source.folderId)?.name ?? null)
        : null
      const targetName = folderId
        ? (foldersRef.current.find(folder => folder.id === folderId)?.name ?? null)
        : null

      pendingRef.current++
      setSources(previous =>
        previous.map(candidate => (candidate.id === sourceId ? { ...candidate, folderId } : candidate))
      )
      try {
        const response = await fetch(`/api/feeds/${sourceId}/folder`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId }),
        })
        if (!response.ok) throw new Error("Move failed")
        setAnnouncement(
          targetName
            ? `${source.name} moved to ${targetName}`
            : `${source.name} removed from ${previousFolderName ?? "the folder"}`
        )
        return true
      } catch {
        setSources(snapshot)
        toast.error(`Couldn’t move “${source.name}” — try again.`)
        return false
      } finally {
        pendingRef.current--
      }
    },
    []
  )

  const createFolder = useCallback(
    async (name: string): Promise<FolderResult> => {
      pendingRef.current++
      try {
        const response = await fetch("/api/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        })
        if (!response.ok) {
          return { ok: false, error: response.status === 409 ? "duplicate" : "failed" }
        }
        const data = (await response.json()) as { folder: SidebarFolder }
        setFolders(previous => [...previous, data.folder].sort(byName))
        const moveSourceId = pendingMoveSourceIdRef.current
        if (moveSourceId) {
          // "New folder…" from a source menu: create, then file the source into
          // it. The move announces itself and refreshes.
          pendingMoveSourceIdRef.current = null
          setPendingMoveSourceId(null)
          await moveSource(moveSourceId, data.folder.id)
        }
        return { ok: true, id: data.folder.id }
      } catch {
        return { ok: false, error: "failed" }
      } finally {
        pendingRef.current--
      }
    },
    [moveSource]
  )

  const renameFolder = useCallback(
    async (id: string, name: string): Promise<FolderResult> => {
      const snapshot = foldersRef.current
      pendingRef.current++
      setFolders(previous =>
        previous.map(folder => (folder.id === id ? { ...folder, name } : folder))
      )
      try {
        const response = await fetch(`/api/folders/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        })
        if (!response.ok) {
          setFolders(snapshot)
          return { ok: false, error: response.status === 409 ? "duplicate" : "failed" }
        }
        setFolders(previous => [...previous].sort(byName))
        router.refresh()
        return { ok: true, id }
      } catch {
        setFolders(snapshot)
        return { ok: false, error: "failed" }
      } finally {
        pendingRef.current--
      }
    },
    [router]
  )

  const deleteFolder = useCallback(
    async (id: string): Promise<boolean> => {
      const snapshot = foldersRef.current
      const sourcesSnapshot = sourcesRef.current
      const folder = snapshot.find(candidate => candidate.id === id)
      pendingRef.current++
      setFolders(previous => previous.filter(candidate => candidate.id !== id))
      // Mirrors the FK's ON DELETE SET NULL: a folder's members move to
      // Uncategorized the moment it disappears, or they would render nowhere
      // (no folder to nest under) until the next server payload.
      setSources(previous =>
        previous.map(source => (source.folderId === id ? { ...source, folderId: null } : source))
      )
      try {
        const response = await fetch(`/api/folders/${id}`, { method: "DELETE" })
        if (!response.ok) throw new Error("Delete failed")
        // Leaving the deleted folder's page: navigate, don't refresh a 404.
        if (pathname === `/folders/${id}`) router.push("/posts")
        return true
      } catch {
        setFolders(snapshot)
        setSources(sourcesSnapshot)
        toast.error(`Couldn’t delete “${folder?.name ?? "folder"}” — try again.`)
        return false
      } finally {
        pendingRef.current--
      }
    },
    [pathname, router]
  )

  const value = useMemo<SidebarTreeContextValue>(
    () => ({
      folders,
      sources,
      collapsed,
      isCreating,
      pendingMoveSourceId,
      flashElementId,
      startCreating,
      cancelCreating,
      createFolder,
      renameFolder,
      deleteFolder,
      moveSource,
      toggleFolder,
      expandFolder,
      isExpanded,
      reveal,
    }),
    [
      folders,
      sources,
      collapsed,
      isCreating,
      pendingMoveSourceId,
      flashElementId,
      startCreating,
      cancelCreating,
      createFolder,
      renameFolder,
      deleteFolder,
      moveSource,
      toggleFolder,
      expandFolder,
      isExpanded,
      reveal,
    ]
  )

  return (
    <SidebarTreeContext.Provider value={value}>
      {children}
      {/* Move announcements for screen readers (the kebab menu is the canonical
          path; a pointer drag gets the same feedback as the menu). */}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </SidebarTreeContext.Provider>
  )
}
