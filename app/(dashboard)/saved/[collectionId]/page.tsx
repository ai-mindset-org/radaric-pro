import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import {
  getCollection,
  getSavedItemsForCollection,
  getSavedExcerptsForCollection,
  getAutoMaterialsForCollection,
} from "@/lib/saved/queries"
import { LivingAnswer } from "@/components/saved/living-answer"
import { SavedMaterialsGrid } from "@/components/saved/saved-materials-grid"
import { SavedExcerptList } from "@/components/saved/saved-excerpt-list"
import { CollectionActions } from "@/components/saved/collection-actions"

export const metadata: Metadata = { title: "Collection" }
export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ collectionId: string }>
}) {
  const { collectionId } = await params
  const { userId } = await requirePaidDashboardAccess()

  const collection = await getCollection(userId, collectionId)
  if (!collection) notFound()

  const [manualItems, excerpts, autoItems] = await Promise.all([
    getSavedItemsForCollection(userId, collectionId),
    getSavedExcerptsForCollection(userId, collectionId),
    getAutoMaterialsForCollection(userId, collection.id, collection.monitorFeedId),
  ])

  // For self-filling collections, auto-collected sources sit alongside any
  // manual saves. Dedup by URL (the same key synthesis uses) so a manually-saved
  // article and its auto-collected twin show once; tag provenance so the grid
  // shows manual saves as unsave-able and auto sources as read-only.
  const seen = new Set(manualItems.map((i) => i.material.url))
  const items = [
    ...manualItems.map((i) => ({ ...i, autoCollected: false })),
    ...autoItems.filter((i) => !seen.has(i.material.url)).map((i) => ({ ...i, autoCollected: true })),
  ]
  const isSelfFilling = collection.query != null

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-6">
      <div>
        <Link
          href="/saved"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-[14px] w-[14px]" aria-hidden />
          Library
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{collection.name}</h1>
      </div>

      <CollectionActions
        collectionId={collection.id}
        name={collection.name}
        query={collection.query}
        cadence={collection.cadence}
        isSystem={collection.isSystem}
      />

      <LivingAnswer
        collectionId={collection.id}
        initialSynthesis={collection.synthesis}
        initialDelta={collection.synthesisDelta}
        initialUpdatedAt={collection.synthesisUpdatedAt ? collection.synthesisUpdatedAt.toISOString() : null}
        trackRequested={collection.trackRequestedAt != null}
        itemCount={items.length}
        excerptCount={excerpts.length}
        isSelfFilling={isSelfFilling}
      />

      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma select shape is a structural match for MaterialCard's material prop */}
      <SavedExcerptList excerpts={excerpts as any} />

      {items.length > 0 ? (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma select shape matches MaterialCard's material prop
        <SavedMaterialsGrid items={items as any} />
      ) : (
        <EmptyCollection name={collection.name} isSelfFilling={isSelfFilling} />
      )}
    </div>
  )
}

function EmptyCollection({ name, isSelfFilling }: { name: string; isSelfFilling: boolean }) {
  return (
    <div className="rounded-xl border border-hairline bg-card p-6 text-center">
      <h2 className="text-sm font-semibold">
        {isSelfFilling ? "Gathering sources…" : "Nothing saved here yet"}
      </h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground leading-relaxed">
        {isSelfFilling
          ? "Radaric is collecting sources for this question on its schedule. They’ll appear here and feed the answer above as they arrive."
          : `Save items into “${name}” and they’ll gather here — every saved passage keeps its link back to the source.`}
      </p>
    </div>
  )
}
