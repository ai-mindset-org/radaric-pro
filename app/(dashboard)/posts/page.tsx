import type { Metadata } from "next"
import { MaterialsList } from "@/components/materials/materials-list"
import { db } from "@/lib/db"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import { fetchMaterialsPage, requireOnboarded } from "@/lib/materials/fetch-materials-page"
import { parsePeek } from "@/lib/peek/peek-state"
import { freshnessProps } from "@/lib/materials/source-freshness"
import { parseableFeedWhere } from "@/lib/materials/parseable-feed-where"
import { getTwitterEntitlement } from "@/lib/entitlements"

export const metadata: Metadata = { title: "Posts" }

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { userId, role } = await requirePaidDashboardAccess({ revisitOnboarding: true })

  const userSettings = await requireOnboarded(userId)

  // When the sources were last checked (RAD-424). Nothing polls in the
  // background, so this is the only way to tell "quiet" from "not refreshed".
  // An X feed a Lite user keeps is never parsed, so it is left out.
  const freshnessPromise = getTwitterEntitlement(userId, role).then(async ({ includesTwitter }) =>
    freshnessProps(
      await db.feed.findMany({
        where: parseableFeedWhere({ userId, includesTwitter, includeInactive: true }),
        select: { status: true, isActive: true, lastParsedAt: true },
      })
    )
  )
  const [{ materials, total, serverCounts }, freshness] = await Promise.all([
    fetchMaterialsPage({ userId }),
    freshnessPromise,
  ])

  // The deep link is read HERE, not in the client: several suites factory-mock
  // `next/navigation`, and `useSearchParams()` would throw in all of them.
  // `?? {}` because page-component tests call this without the prop.
  const params = (await searchParams) ?? {}
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") search.set(key, value)
    else if (Array.isArray(value)) for (const entry of value) search.append(key, entry)
  }
  const initialPeek = parsePeek(search)

  const showFirstParse = !userSettings.onboardingBannerDismissed && total === 0
  const feedCount = showFirstParse ? await db.feed.count({ where: { userId, isActive: true, hidden: false } }) : 0

  return (
    <>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma select return type doesn't match Material interface exactly */}
      <MaterialsList initialMaterials={materials as any} totalCount={total} serverCounts={serverCounts} hasNotionIntegration={!!(userSettings.notionToken && userSettings.notionDatabaseId)} hasStoryNotionIntegration={!!(userSettings.notionToken && userSettings.storyNotionDatabaseId)} initialPeek={initialPeek} firstRunSourceCount={showFirstParse ? feedCount : 0} freshness={freshness} />
    </>
  )
}
