import Link from "next/link"
import { Bookmark, Quote, Radar } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { CollectionWithCounts } from "@/lib/saved/queries"

export function CollectionCard({ collection }: { collection: CollectionWithCounts }) {
  const isSelfFilling = collection.query != null
  return (
    <Link
      href={`/saved/${collection.id}`}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
    >
      <Card interactive className="h-full">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold leading-snug line-clamp-2">{collection.name}</h3>
            {isSelfFilling && (
              <span
                className="type-tag inline-flex shrink-0 items-center gap-1 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-medium text-primary-subtle-foreground"
                title="Updates automatically as new sources arrive"
              >
                <Radar className="h-[12px] w-[12px]" aria-hidden />
                Tracking
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">
            {isSelfFilling
              ? collection.query
              : "A maintained answer will live here as it grows."}
          </p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
            <span className="inline-flex items-center gap-1">
              <Bookmark className="h-[14px] w-[14px]" aria-hidden />
              <span className="type-counter">{collection.itemCount}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Quote className="h-[14px] w-[14px]" aria-hidden />
              <span className="type-counter">{collection.excerptCount}</span>
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
