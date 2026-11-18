import { cookies } from "next/headers"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { VerifyEmailNotice } from "@/components/auth/verify-email-notice"
import { AiNotConfiguredNotice } from "@/components/system/ai-not-configured-notice"
import { TypographyProvider } from "@/components/providers/typography-provider"
import { loadTypography } from "@/lib/typography/load"
import type { SidebarFolder, SidebarSource } from "@/components/layout/sidebar"
import { FOLDERS_COLLAPSED_COOKIE, SIDEBAR_OPEN_COOKIE } from "@/lib/ui-state"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const cookieStore = await cookies()
  const initialSidebarOpen = cookieStore.get(SIDEBAR_OPEN_COOKIE)?.value !== "0"
  // Collapsed folder ids (RAD-393). Lenient parse: a corrupt cookie must only
  // cost the collapse state, never the layout.
  let initialCollapsedFolders: string[] = []
  const collapsedRaw = cookieStore.get(FOLDERS_COLLAPSED_COOKIE)?.value
  if (collapsedRaw) {
    try {
      const parsed = JSON.parse(collapsedRaw)
      if (Array.isArray(parsed)) {
        initialCollapsedFolders = parsed.filter((id): id is string => typeof id === "string")
      }
    } catch {
      initialCollapsedFolders = []
    }
  }

  // Fetch active sources for the sidebar. Unauthed visitors fall through to
  // the per-page auth redirect; sidebar renders empty for them.
  const session = await auth()
  const userId = session?.user?.id
  // Started before the sidebar queries so it runs in parallel; never rejects.
  const typographyPromise = loadTypography(userId)
  let sources: SidebarSource[] = []
  let folders: SidebarFolder[] = []
  if (userId) {
    const [feeds, inboxCounts, folderRows] = await Promise.all([
      db.feed.findMany({
        where: { userId, isActive: true, hidden: false },
        select: { id: true, name: true, type: true, coverUrl: true, faviconUrl: true, folderId: true },
        orderBy: { name: "asc" },
      }),
      // Per-source Inbox count (AI-approved, not archived/deleted) — matches
      // the "Inbox" filter count on the posts page. Excludes hidden backing
      // feeds so tracked-question material doesn't inflate sidebar counts.
      db.material.groupBy({
        by: ["sourceId"],
        where: {
          feed: { userId, isActive: true, hidden: false },
          aiEvaluation: "APPROVED",
          userStatus: { notIn: ["DELETED", "ARCHIVED"] },
        },
        _count: { _all: true },
      }),
      db.folder.findMany({
        where: { userId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ])
    const inboxBySource = new Map(inboxCounts.map((c) => [c.sourceId, c._count._all]))
    sources = feeds.map((f) => ({ ...f, inboxCount: inboxBySource.get(f.id) ?? 0 }))
    folders = folderRows
    // Self-heal: drop ids of folders that no longer exist, so the cookie
    // cannot accumulate dead entries forever.
    const liveFolderIds = new Set(folders.map((folder) => folder.id))
    initialCollapsedFolders = initialCollapsedFolders.filter((id) => liveFolderIds.has(id))
  }
  const typography = await typographyPromise

  return (
    <TypographyProvider initialPrefs={typography}>
      <DashboardShell
        initialSidebarOpen={initialSidebarOpen}
        sources={sources}
        folders={folders}
        initialCollapsedFolders={initialCollapsedFolders}
        banner={<><VerifyEmailNotice /><AiNotConfiguredNotice /></>}
      >
        {children}
      </DashboardShell>
    </TypographyProvider>
  )
}
