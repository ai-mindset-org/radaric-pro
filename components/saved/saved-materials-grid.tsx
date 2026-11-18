"use client"

import { useRouter } from "next/navigation"
import { MaterialCard } from "@/components/materials/material-card"

type SavedMaterial = {
  savedId: string
  material: React.ComponentProps<typeof MaterialCard>["material"]
  /** Auto-collected by the backing monitor (not user-saved) → read-only, no Save toggle. */
  autoCollected?: boolean
}

/**
 * The whole-materials of a collection, rendered with the same MaterialCard as
 * the feed. Manually-saved items show the filled Save toggle (clicking unsaves
 * them from the collection). Auto-collected items (a self-filling collection's
 * monitor results) are read-only sources — no Save toggle, since the user never
 * saved them and there's nothing to unsave. No archive/delete cluster here.
 */
export function SavedMaterialsGrid({ items }: { items: SavedMaterial[] }) {
  const router = useRouter()
  if (items.length === 0) return null
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map(({ savedId, material, autoCollected }) =>
        autoCollected ? (
          <MaterialCard key={savedId} material={material} hideSave />
        ) : (
          <MaterialCard
            key={savedId}
            material={{ ...material, savedItems: [{ id: savedId }] }}
            // Unsaving here removes the item from this collection — refresh so the
            // card disappears and the counts update.
            onUnsave={() => router.refresh()}
          />
        )
      )}
    </div>
  )
}
