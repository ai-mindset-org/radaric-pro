/**
 * Shared chrome for the two long-form reading surfaces — a material
 * (`/posts/[id]`) and a story (`/stories/[id]`).
 *
 * The governing decision: **below `sm` the article IS the page.** A card frame
 * inside a 375px viewport spends 26px of gutter plus 38px of padding on
 * decoration — 17% of the width — and then wraps the body to a ~34-character
 * measure. So on mobile the card chrome (surface, radius, elevation) is
 * dropped entirely and the content sits on the canvas with one 16px gutter;
 * from `sm` up the card comes back exactly as it was.
 *
 * Note for every pixel figure in this file: the app sets `--spacing: 0.2rem`
 * (app/globals.css, "density unit (intentionally tight)"), so every Tailwind
 * spacing utility is 80% of its stock size — `px-5` is 16px, `p-8` is 25.6px,
 * `h-11` is 35.2px. Do not read these classes at the default 0.25rem scale.
 *
 * `sm` (640px) rather than the shell's `md` (768px): the sidebar breakpoint is
 * about the app frame, this one is about reading measure, and at 640px there
 * is already enough width for a card to earn its padding.
 */

import { cn } from "@/lib/utils"
import { BackButton } from "@/components/back-button"

/** Page gutter on mobile (`px-5` = 16px); from `sm` up the card supplies its own 25.6px. */
const READING_GUTTER = "px-5 sm:px-4"

export function ReadingShell({
  children,
  backFallback,
}: {
  children: React.ReactNode
  /** Where Back goes when the detail page is the first entry in the tab's history. */
  backFallback?: string
}) {
  return (
    <div className="min-h-screen">
      {/* Top bar — sticky over the scrolling article. */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm">
        <div className={cn("max-w-[850px] mx-auto py-2 sm:py-3 flex items-center", READING_GUTTER)}>
          <BackButton fallback={backFallback} />
        </div>
      </div>

      <article className={cn("max-w-[850px] mx-auto pb-16 sm:py-8", READING_GUTTER)}>
        {/* Card chrome from `sm` up only — see the module comment. */}
        <div className="sm:bg-card sm:rounded-xl sm:shadow-[var(--shadow-card)] sm:overflow-hidden sm:p-8">
          {children}
        </div>
      </article>
    </div>
  )
}

/**
 * Full-bleed on mobile (cancels the page gutter), clipped by the card's own
 * `overflow-hidden` from `sm` up (cancels the card padding).
 */
export function ReadingHero({ children }: { children: React.ReactNode }) {
  return <div className="-mx-5 sm:-mx-8 sm:-mt-8 bg-muted">{children}</div>
}

/**
 * The eyebrow above a section body. Uppercase + tracked so an 11px label reads
 * as a label rather than as small body copy.
 *
 * `as` exists because these labels sit at two depths: a section of the page
 * itself, and the AI-Reasoning plaque nested inside one. Fixing them all at
 * `h2` would rank the plaque with the page's own sections in the heading rotor.
 */
export function SectionLabel({
  as: Tag = "h2",
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Tag
      className={cn(
        "type-tag text-[0.6875rem] font-semibold uppercase tracking-[calc(0.09em*var(--type-cf,1))] text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
    </Tag>
  )
}

/** Article headline. 26px on mobile, tightened so three lines still read as one block. */
export function ReadingTitle({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="text-[1.625rem] leading-[1.18] sm:text-3xl sm:leading-tight font-bold tracking-[calc(-0.021em*var(--type-df,1))] text-balance">
      {children}
    </h1>
  )
}

/**
 * The action rail: signals on the left, utilities pinned right, **one row at
 * every width**. It previously wrapped on mobile, dropping the icon cluster
 * onto a second line flush right with nothing under it — the single most
 * visible break in the old layout.
 *
 * No rules above or below it: with icon-only controls the rail already reads
 * as its own band, and a hairline there only competes with the type.
 *
 * The 44px floor is gated on `pointer: coarse`, not on a width breakpoint — an
 * iPad in portrait reports 768 CSS px, so a `max-sm:` gate would hand a thumb
 * the 35.2px `size="icon"` target the floor exists to prevent, with a
 * destructive Delete 1.6px from its neighbour.
 */
export function ActionRail({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-center gap-0.5 -mx-[14px] sm:-mx-3 [@media(pointer:coarse)]:[&_button]:h-[44px] [@media(pointer:coarse)]:[&_button]:min-w-[44px]">
      {children}
    </div>
  )
}
