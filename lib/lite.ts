// ---------------------------------------------------------------------------
// Radar-lite switch (club fork). NEXT_PUBLIC_RADARIC_LITE=1 at build time hides
// the parts a beginner's radar does not need: X, event triggers and interests
// (Parallel), the Library, the admin page. Sources, the feed, the filter rule,
// like and dislike stay. Off by default; the full product is unchanged.
// NEXT_PUBLIC_ so client components see it too: Next inlines it at build time.
// ---------------------------------------------------------------------------

export const LITE = process.env.NEXT_PUBLIC_RADARIC_LITE === "1"

/** Source types the lite build does not offer. */
export const LITE_HIDDEN_SOURCE_TYPES: ReadonlySet<string> = new Set(["TWITTER", "EVENT_TRIGGER", "INTEREST"])
