import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MaterialsList } from "@/components/materials/materials-list"
import { typeColorClass } from "@/lib/feed-type-color"
import { detectFlavor, FLAVOR_CONFIGS } from "@/lib/feed-flavor"
import { cn } from "@/lib/utils"
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

export const metadata: Metadata = { title: "Source" }

export const dynamic = "force-dynamic"
export const revalidate = 0

const TYPE_LABELS: Record<string, string> = {
  RSS: "RSS",
  TELEGRAM: "Telegram",
  TWITTER: "X",
  YOUTUBE: "YouTube",
  INTEREST: "Event trigger",
  EVENT_TRIGGER: "Event trigger",
}

const URL_DISPLAY_MAX = 30

/**
 * Best-effort display label for a feed's URL.
 *
 * - TWITTER: extract the handle from `https://x.com/handle` (or twitter.com)
 *   and render as `@handle` — avoids showing a bare "x.com" that says
 *   nothing about which account the feed tracks.
 * - Everything else: strip the protocol and trailing slash, truncate with
 *   an ellipsis when longer than 30 characters so a long RSS path doesn't
 *   push the toolbar off screen.
 */
function displayUrl(feed: { type: string; url: string | null }): string | null {
  if (!feed.url) return null
  if (feed.type === "TWITTER") {
    const handle = feed.url
      .replace(/^https?:\/\/(x|twitter)\.com\//, "")
      .split("/")[0]
    if (handle) return `@${handle}`
  }
  const clean = feed.url.replace(/^https?:\/\//, "").replace(/\/$/, "")
  if (clean.length <= URL_DISPLAY_MAX) return clean
  return clean.slice(0, URL_DISPLAY_MAX - 1) + "…"
}

export default async function FeedMaterialsPage({
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

  // Parallelize the feed lookup and the notion settings fetch — neither
  // depends on the other and both are independent of the materials query.
  const [feed, userSettings] = await Promise.all([
    db.feed.findFirst({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        type: true,
        url: true,
        coverUrl: true,
        status: true,
        isActive: true,
        lastParsedAt: true,
      },
    }),
    db.userSettings.findUnique({
      where: { userId },
      select: { notionToken: true, notionDatabaseId: true, storyNotionDatabaseId: true },
    }),
  ])

  if (!feed) {
    notFound()
  }

  const { materials, total, serverCounts } = await fetchMaterialsPage({
    userId,
    feedId: id,
  })

  // An X feed kept by a user without the X entitlement is never parsed, so a
  // "checked N days ago" line would be a permanent lie: show none (RAD-424).
  const includesTwitter =
    feed.type === "TWITTER" ? (await getTwitterEntitlement(userId, session.user.role || "USER")).includesTwitter : true
  const freshness = isParseableType(feed.type, includesTwitter) ? freshnessProps([feed]) : undefined

  // Branded RSS feeds show the brand name in the type badge (derived from the
  // URL on read — no stored column; tint stays the RSS one). RAD-268
  const flavor = feed.type === "RSS" && feed.url ? detectFlavor(feed.url) : null
  const typeLabel = flavor ? FLAVOR_CONFIGS[flavor].label : TYPE_LABELS[feed.type] ?? feed.type
  const urlLabel = displayUrl(feed)

  // 48×48 leading cover — sits next to the feed name in the unified
  // MaterialsList header (no separate 96px hero band). Matches the /posts
  // layout shape so switching between All and a source doesn't jump.
  // Keyed on purpose. This element is created in a server component and reaches
  // the client toolbar through the RSC payload, which drops React's "these
  // children are static" hint — so it arrives as an array member and warns
  // without one.
  const leading = (
    <div
      key="source-cover"
      className="icon-tile h-12 w-12 shrink-0 overflow-hidden bg-secondary flex items-center justify-center"
      style={{ "--tile-size": "3rem" } as React.CSSProperties}
    >
      {feed.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external favicon/og image, size is fixed 48×48
        <img
          src={feed.coverUrl}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="text-base font-semibold uppercase text-muted-foreground">
          {feed.name.slice(0, 1)}
        </span>
      )}
    </div>
  )

  const subtitle = (
    <>
      <Badge
        className={cn(
          "h-5 px-2 text-[11px] font-medium border-transparent shrink-0",
          typeColorClass(feed.type)
        )}
      >
        {typeLabel}
      </Badge>
      {urlLabel && (
        <span className="truncate" title={feed.url ?? undefined}>
          {urlLabel}
        </span>
      )}
      {/*
        No all-statuses item total here. The toolbar heading now carries the
        one number for this screen, and the sidebar row carries the per-source
        inbox count; a third total that disagrees with both by definition is
        noise, not information.
      */}
    </>
  )

  // Edit sits beside the parsing primary in the toolbar. `h-11 w-11` reads as
  // 44px but `--spacing` is 0.2rem, so it renders 35.2px — under the touch
  // floor it was written to meet. The pixel values are explicit for that reason.
  const headerExtra = (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="min-h-[44px] min-w-[44px] p-0 sm:min-h-0 sm:min-w-0 sm:h-9 sm:w-auto sm:px-3 md:h-9"
    >
      <Link
        href={`/feeds/${feed.id}/edit`}
        className="flex items-center gap-1.5"
        aria-label="Edit source"
      >
        <Pencil className="h-[14px] w-[14px]" />
        <span className="hidden sm:inline">Edit</span>
      </Link>
    </Button>
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma select return type doesn't match MaterialsList's hand-rolled Material interface exactly
  const initialMaterials = materials as any[]

  // Deep link (`?post=` / `?story=`), read on the server for the same reason
  // as on /posts: the client must not call `useSearchParams`. `?? {}` because
  // page-component tests call this without the prop.
  const query = (await searchParams) ?? {}
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") search.set(key, value)
    else if (Array.isArray(value)) for (const entry of value) search.append(key, entry)
  }
  const initialPeek = parsePeek(search)

  return (
    <MaterialsList
      initialMaterials={initialMaterials}
      totalCount={total}
      serverCounts={serverCounts}
      hideSourceTypeFilter
      title={feed.name}
      subtitle={subtitle}
      leading={leading}
      headerExtra={headerExtra}
      feedId={feed.id}
      freshness={freshness}
      hasNotionIntegration={!!(userSettings?.notionToken && userSettings?.notionDatabaseId)}
      hasStoryNotionIntegration={!!(userSettings?.notionToken && userSettings?.storyNotionDatabaseId)}
      initialPeek={initialPeek}
    />
  )
}
