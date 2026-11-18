import type { Metadata } from "next"
import { Bookmark } from "lucide-react"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import { getCollectionsWithCounts, getSavedTotals } from "@/lib/saved/queries"
import { CollectionCard } from "@/components/saved/collection-card"
import { TrackQuestionDialog } from "@/components/saved/track-question-dialog"

export const metadata: Metadata = { title: "Library" }
export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function LibraryPage() {
  const { userId } = await requirePaidDashboardAccess()
  const [collections, totals] = await Promise.all([
    getCollectionsWithCounts(userId),
    getSavedTotals(userId),
  ])

  const isEmpty = collections.length === 0 && totals.items === 0 && totals.excerpts === 0

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            {isEmpty
              ? "Your knowledge base starts here."
              : `${totals.items} saved ${totals.items === 1 ? "item" : "items"} · ${totals.excerpts} ${
                  totals.excerpts === 1 ? "excerpt" : "excerpts"
                } across ${collections.length} ${collections.length === 1 ? "collection" : "collections"}`}
          </p>
        </div>
        <TrackQuestionDialog />
      </header>

      {isEmpty ? (
        <EmptyLibrary />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {collections.map((c) => (
            <CollectionCard key={c.id} collection={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyLibrary() {
  return (
    <div className="rounded-2xl border border-hairline bg-card p-8 sm:p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-sm bg-primary-subtle text-primary-subtle-foreground">
        <Bookmark className="h-[22px] w-[22px] opacity-30" aria-hidden />
      </div>
      <h2 className="text-base font-semibold">Your knowledge base starts here</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground leading-relaxed">
        Save whole items or highlight a passage to keep as a citation. Group them by what
        you’re tracking, and Radaric starts maintaining an answer for each.
      </p>

      {/* Sell the future: a dashed placeholder collection showing the dormant
          living-answer slot, so the magic moment is planted before any save. */}
      <div className="mx-auto mt-6 max-w-md rounded-xl border border-dashed border-border bg-muted/40 p-4 text-left">
        <div className="text-sm font-medium">Your first collection</div>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
          A maintained answer will live here. No saved item, no claim without a receipt.
        </p>
      </div>
    </div>
  )
}
