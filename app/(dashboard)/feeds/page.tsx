import type { Metadata } from "next"
import { Plus } from "lucide-react"
import { db } from "@/lib/db"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { FeedsList } from "@/components/feeds/feeds-list"
import { FeedTypeCards } from "@/components/feeds/feed-type-cards"
import { BulkAddFeedsDialog } from "@/components/feeds/bulk-add-feeds-dialog"
import { Button } from "@/components/ui/button"

export const metadata: Metadata = { title: "Feeds" }
export const dynamic = "force-dynamic"

export default async function FeedsPage() {
  const { userId, role } = await requirePaidDashboardAccess({ revisitOnboarding: true })

  const [feeds, { includesTwitter }] = await Promise.all([
    db.feed.findMany({
      where: { userId, hidden: false },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { materials: true },
        },
      },
    }),
    getTwitterEntitlement(userId, role),
  ])

  return (
    <div className="p-4 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mt-2 lg:mt-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Feeds</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Manage content feeds
          </p>
        </div>
        <BulkAddFeedsDialog>
          <Button size="sm" className="md:text-base md:h-9" aria-label="Add feeds">
            <Plus className="h-[16px] w-[16px] md:mr-2" aria-hidden="true" />
            <span className="hidden md:inline">Add feeds</span>
          </Button>
        </BulkAddFeedsDialog>
      </div>

      {/* Quick-add feed type cards */}
      <FeedTypeCards includesTwitter={includesTwitter} />

      {feeds.length === 0 ? (
        <EmptyState />
      ) : (
        <FeedsList initialSources={feeds} includesTwitter={includesTwitter} />
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl surface-card p-8 md:p-12">
      <div className="flex h-16 w-16 items-center justify-center rounded-md bg-muted">
        <Plus className="h-[32px] w-[32px] text-muted-foreground" />
      </div>
      <h3 className="mt-4 text-lg font-semibold">No feeds</h3>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        Add your first content feeds to get started
      </p>
      <div className="mt-4">
        <BulkAddFeedsDialog>
          <Button>
            <Plus className="mr-2 h-[16px] w-[16px]" aria-hidden="true" />
            Add feeds
          </Button>
        </BulkAddFeedsDialog>
      </div>
    </div>
  )
}
