/**
 * The peek's reading column (RAD-345) — the full-page post's own stack, minus
 * the card's visuals.
 *
 * `ReadingShell` gives a page `max-w-[850px]` + `px-5 sm:px-4` (the reading
 * gutter) and then a card contributing `sm:p-8`. With only the gutter, the peek
 * renders the article 850px wide inside the panel while the same article on
 * `/posts/[id]` renders 773px — same content, two measures. This wrapper
 * restates both insets in one place, so the peek and the page cannot drift;
 * the card's surface, radius and shadow are the only parts of that stack the
 * peek does not take.
 */

export function PeekColumn({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[850px] px-5 sm:px-4 pb-16 sm:py-8">
      <div className="sm:p-8">{children}</div>
    </div>
  )
}
