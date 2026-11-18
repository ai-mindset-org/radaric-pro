import type { Metadata } from "next"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { NewFeedPage } from "@/components/feeds/new-feed-content"

export const metadata: Metadata = { title: "Add Feed" }
export const dynamic = "force-dynamic"

export default async function Page() {
  const { userId, role } = await requirePaidDashboardAccess()
  const { includesTwitter } = await getTwitterEntitlement(userId, role)

  return <NewFeedPage includesTwitter={includesTwitter} />
}
