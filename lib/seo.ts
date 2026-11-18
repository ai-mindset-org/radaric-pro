import type { Metadata } from "next"

// Title and description live here because both the metadata and the JSON-LD
// state the product, and they must not drift apart.
const LANDING_TITLE = "Radaric — Your content taste, but scaled"
const LANDING_DESCRIPTION =
  "Stop scrolling and start reading what’s really worth it. AI learns from every approve and reject across RSS, Telegram, YouTube and X. From $9/mo, X on Pro."
const OG_TITLE = "Your content taste, but scaled"
const OG_DESCRIPTION = "Stop scrolling and start reading what’s really worth it."

/** Metadata for the landing page: share cards, the canonical URL and the title. */
export function buildLandingMetadata(siteUrl: string): Metadata {
  return {
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    openGraph: {
      title: OG_TITLE,
      description: OG_DESCRIPTION,
      url: siteUrl,
      siteName: "Radaric",
      // ?v= busts the share caches: X and Telegram key a card by its image URL,
      // so a new picture at the same path never reaches an already-shared link.
      // Bump it whenever scripts/og-image re-renders the file.
      images: [{ url: "/og-image.png?v=2", width: 1200, height: 630 }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: OG_TITLE,
      description: OG_DESCRIPTION,
      images: ["/og-image.png?v=2"],
    },
    // Left without a trailing slash on purpose: Next normalises it away in the
    // built output either way (verified against .next/server/app/index.html), so
    // adding one is a no-op that only looks like it does something.
    alternates: { canonical: siteUrl },
  }
}

/**
 * Structured data for the landing page.
 *
 * One @graph with cross-referenced @ids rather than three loose blocks, so the
 * app, the site and the publisher are stated as one connected entity.
 *
 * Deliberately omitted:
 *  - `aggregateRating` — the Software App rich result requires it, but Radaric
 *    has no first-party ratings, and importing third-party ones violates
 *    Google's "don't aggregate reviews from other websites" rule. Self-authored
 *    ratings earn a manual action ("Review written by the site or person
 *    providing the service") regardless of schema type. So the rich result is
 *    unreachable until real ratings exist — that is the honest state, not an
 *    oversight to be "fixed" later.
 *  - `SearchAction` / sitelinks searchbox — the feature was retired 2024-11-21
 *    and produces nothing today.
 *  - `Product` — merchant listings require a purchasable page, and recurring
 *    subscriptions are explicitly unsupported.
 */
export function buildLandingStructuredData(siteUrl: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: "Radaric",
        url: `${siteUrl}/`,
        // A square mark, not the share banner: Google wants a logo ≥112px that
        // reads at favicon size, and the og:image carries no logo at all.
        logo: `${siteUrl}/apple-icon.png`,
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        url: `${siteUrl}/`,
        name: "Radaric",
        publisher: { "@id": `${siteUrl}/#organization` },
        inLanguage: "en",
      },
      {
        // Both types: it is software, and it is delivered in a browser.
        "@type": ["SoftwareApplication", "WebApplication"],
        "@id": `${siteUrl}/#app`,
        name: "Radaric",
        url: `${siteUrl}/`,
        // From Google's supported enum — not a free-text label.
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        publisher: { "@id": `${siteUrl}/#organization` },
        description:
          "AI content curation that learns your editorial taste. Connects to RSS, Telegram, YouTube and Twitter/X, reads video transcripts, filters hundreds of items per day and learns from every approval.",
        featureList: [
          "RSS and OPML bulk import",
          "Telegram channel ingestion",
          "YouTube ingestion with transcript-based evaluation",
          "Twitter/X ingestion",
          "Per-feed and global AI filtering prompts",
          "Feedback-based learning from every approval and rejection",
          "Story aggregation across sources",
          "Notion export",
        ],
        offers: [
          {
            "@type": "Offer",
            name: "Lite",
            price: "9",
            priceCurrency: "USD",
            url: `${siteUrl}/`,
          },
          {
            "@type": "Offer",
            name: "Pro",
            price: "59",
            priceCurrency: "USD",
            url: `${siteUrl}/`,
          },
        ],
      },
    ],
  }
}
