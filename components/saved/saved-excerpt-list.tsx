import Link from "next/link"

type Excerpt = {
  id: string
  text: string
  material: { id: string; title: string; feed: { id: string; name: string } }
}

/**
 * Saved excerpts in a collection — each a citation atom: the quoted passage
 * with its source link. The green edge-marker echoes the in-text highlight.
 */
export function SavedExcerptList({ excerpts }: { excerpts: Excerpt[] }) {
  if (excerpts.length === 0) return null
  return (
    <section aria-label="Saved excerpts" className="space-y-3">
      <h2 className="type-tag text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Excerpts
      </h2>
      <ul role="list" className="space-y-3">
        {excerpts.map((ex) => (
          <li key={ex.id}>
            <figure className="rounded-xl border border-hairline bg-card p-4">
              <blockquote className="relative pl-4 text-sm leading-relaxed before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[2px] before:rounded-full before:bg-green-bright">
                {ex.text}
              </blockquote>
              <figcaption className="mt-2 text-xs text-muted-foreground">
                from{" "}
                <Link
                  href={`/posts/${ex.material.id}`}
                  className="hover:text-foreground hover:underline"
                >
                  {ex.material.title}
                </Link>{" "}
                · {ex.material.feed.name}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  )
}
