import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { Folder as FolderIcon } from "lucide-react"
import { MaterialsList } from "@/components/materials/materials-list"
import { FolderEmptyState } from "@/components/layout/folder-empty-state"
import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import {
  fetchMaterialsPage,
  requireOnboarded,
} from "@/lib/materials/fetch-materials-page"
import { parsePeek } from "@/lib/peek/peek-state"
import { freshnessProps } from "@/lib/materials/source-freshness"
import { isParseableType } from "@/lib/materials/parseable-feed-where"
import { getTwitterEntitlement } from "@/lib/entitlements"

export const metadata: Metadata = { title: "Folder" }

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * `/folders/[id]` (RAD-393) — the folder's materials, scoped to its visible,
 * active member sources. Mirrors `/feeds/[id]`: same auth/onboarding gates,
 * same 404-for-foreign semantics, same unified MaterialsList layout. Unlike a
 * single-source page it keeps the source-type filter and the subtitle visible —
 * a folder is a multi-source scope.
 */
export default async function FolderMaterialsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signup")
  }
  const userId = session.user.id

  await requireOnboarded(userId)

  const { id } = await params

  const [folder, userSettings] = await Promise.all([
    db.folder.findFirst({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        // The visible member set the scope and the subtitle both use.
        feeds: {
          where: { hidden: false, isActive: true },
          select: { id: true, type: true, status: true, isActive: true, lastParsedAt: true },
        },
      },
    }),
    db.userSettings.findUnique({
      where: { userId },
      select: { notionToken: true, notionDatabaseId: true, storyNotionDatabaseId: true },
    }),
  ])

  if (!folder) {
    notFound()
  }

  const folderSourceIds = folder.feeds.map(feed => feed.id)
  const sourceCount = folderSourceIds.length

  if (sourceCount === 0) {
    return <FolderEmptyState name={folder.name} />
  }

  const { materials, total, serverCounts } = await fetchMaterialsPage({
    userId,
    folderId: id,
  })

  // X feeds a user without the X entitlement keeps are never parsed; counting
  // them would pin the line to "not checked yet" (RAD-424).
  const hasTwitterMember = folder.feeds.some(feed => feed.type === "TWITTER")
  const includesTwitter = hasTwitterMember
    ? (await getTwitterEntitlement(userId, session.user.role || "USER")).includesTwitter
    : true
  const freshness = freshnessProps(folder.feeds.filter(feed => isParseableType(feed.type, includesTwitter)))

  // 48×48 leading tile — same shape as /feeds/[id], so switching between a
  // folder and a source doesn't jump. Keyed on purpose: the element crosses
  // the RSC boundary as an array member (see the feed page's note).
  const leading = (
    <div
      key="folder-tile"
      className="icon-tile h-12 w-12 shrink-0 overflow-hidden bg-secondary flex items-center justify-center"
      style={{ "--tile-size": "3rem" } as React.CSSProperties}
    >
      <FolderIcon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
    </div>
  )

  const subtitle = (
    <span className="truncate">
      {sourceCount} {sourceCount === 1 ? "source" : "sources"}
    </span>
  )

  // Deep link (`?post=` / `?story=`), read on the server like the other lists.
  const query = (await searchParams) ?? {}
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") search.set(key, value)
    else if (Array.isArray(value)) for (const entry of value) search.append(key, entry)
  }
  const initialPeek = parsePeek(search)

  return (
    <MaterialsList
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma select return type doesn't match Material interface exactly
      initialMaterials={materials as any[]}
      totalCount={total}
      serverCounts={serverCounts}
      title={folder.name}
      scopeName={folder.name}
      subtitle={subtitle}
      leading={leading}
      folderId={folder.id}
      folderSourceIds={folderSourceIds}
      freshness={freshness}
      hasNotionIntegration={!!(userSettings?.notionToken && userSettings?.notionDatabaseId)}
      hasStoryNotionIntegration={!!(userSettings?.notionToken && userSettings?.storyNotionDatabaseId)}
      initialPeek={initialPeek}
    />
  )
}
