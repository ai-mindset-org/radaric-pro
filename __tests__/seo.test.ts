// @vitest-environment node

/**
 * The URLs the app states about itself — sitemap, robots.txt, the root
 * `metadataBase`, the landing canonical and its JSON-LD.
 *
 * Two properties are pinned here:
 *  - with the hosted origin the output is exactly the literals it used to be
 *    (nothing about the hosted service changes);
 *  - with another origin every one of them follows it, and `robots()` /
 *    `sitemap()` read it per call rather than once at import — the Docker image
 *    is built without an app URL, so a build-time value would ship localhost.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { buildLandingMetadata, buildLandingStructuredData } from "@/lib/seo"
import { getSiteUrl } from "@/lib/site-url"
import robots from "@/app/robots"
import sitemap from "@/app/sitemap"

const HOSTED = "https://radaric.pro"
const SELF_HOSTED = "https://feeds.example.org"

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv("NEXT_PUBLIC_APP_URL", HOSTED)
  vi.stubEnv("NEXTAUTH_URL", HOSTED)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** The JSON-LD exactly as the landing page emitted it before the origin moved into the environment. */
const HOSTED_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://radaric.pro/#organization",
      name: "Radaric",
      url: "https://radaric.pro/",
      logo: "https://radaric.pro/apple-icon.png",
    },
    {
      "@type": "WebSite",
      "@id": "https://radaric.pro/#website",
      url: "https://radaric.pro/",
      name: "Radaric",
      publisher: { "@id": "https://radaric.pro/#organization" },
      inLanguage: "en",
    },
    {
      "@type": ["SoftwareApplication", "WebApplication"],
      "@id": "https://radaric.pro/#app",
      name: "Radaric",
      url: "https://radaric.pro/",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      publisher: { "@id": "https://radaric.pro/#organization" },
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
        "Self-hosting with Docker Compose",
      ],
      offers: [
        { "@type": "Offer", name: "Self-hosted", price: "0", priceCurrency: "USD", url: "https://radaric.pro/" },
        { "@type": "Offer", name: "Lite", price: "9", priceCurrency: "USD", url: "https://radaric.pro/" },
        { "@type": "Offer", name: "Pro", price: "59", priceCurrency: "USD", url: "https://radaric.pro/" },
      ],
    },
  ],
}

const sitemapUrls = (host: string) => [
  host,
  `${host}/login`,
  `${host}/signup`,
  `${host}/terms`,
  `${host}/privacy`,
]

describe("with the hosted origin", () => {
  it("keeps the sitemap URLs byte-identical", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual(sitemapUrls(HOSTED))
  })

  it("keeps the robots sitemap line byte-identical", () => {
    expect(robots().sitemap).toBe(`${HOSTED}/sitemap.xml`)
  })

  it("keeps metadataBase, canonical and Open Graph on the hosted origin", () => {
    // metadataBase is built inline in the root layout (a frozen test pins the
    // title literal there); this proves the value it is given, and the wiring
    // test below proves the layout asks for it.
    expect(new URL(getSiteUrl()).toString()).toBe("https://radaric.pro/")

    const landing = buildLandingMetadata(HOSTED)
    expect(landing.alternates?.canonical).toBe(HOSTED)
    expect(landing.openGraph?.url).toBe(HOSTED)
  })

  it("emits the same JSON-LD the page carried as literals", () => {
    expect(buildLandingStructuredData(HOSTED)).toEqual(HOSTED_STRUCTURED_DATA)
  })
})

describe("with another origin", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", SELF_HOSTED)
    vi.stubEnv("NEXTAUTH_URL", SELF_HOSTED)
  })

  it("moves every sitemap URL", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual(sitemapUrls(SELF_HOSTED))
  })

  it("moves the robots sitemap line", () => {
    expect(robots().sitemap).toBe(`${SELF_HOSTED}/sitemap.xml`)
  })

  it("moves metadataBase, canonical and Open Graph", () => {
    expect(new URL(getSiteUrl()).toString()).toBe(`${SELF_HOSTED}/`)
    expect(buildLandingMetadata(SELF_HOSTED).alternates?.canonical).toBe(SELF_HOSTED)
    expect(buildLandingMetadata(SELF_HOSTED).openGraph?.url).toBe(SELF_HOSTED)
  })

  it("moves every URL in the JSON-LD, ids included", () => {
    const data = JSON.stringify(buildLandingStructuredData(SELF_HOSTED))
    expect(data).not.toContain("radaric.pro")
    expect(data).toContain(`${SELF_HOSTED}/#organization`)
    expect(data).toContain(`${SELF_HOSTED}/#website`)
    expect(data).toContain(`${SELF_HOSTED}/#app`)
    expect(data).toContain(`${SELF_HOSTED}/apple-icon.png`)

    const graph = buildLandingStructuredData(SELF_HOSTED)["@graph"]
    const urls = JSON.stringify(graph).match(/https?:\/\/[^"]+/g) ?? []
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(url.startsWith(`${SELF_HOSTED}/`)).toBe(true)
  })

  it("routes() and sitemap() read the environment on every call", () => {
    // The same module instance, a different environment: a value captured at
    // import time would keep answering with the old host.
    expect(robots().sitemap).toBe(`${SELF_HOSTED}/sitemap.xml`)
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://moved.example")
    expect(robots().sitemap).toBe("https://moved.example/sitemap.xml")
    expect(sitemap()[0].url).toBe("https://moved.example")
  })

  it("follows NEXTAUTH_URL when only that is set", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    expect(robots().sitemap).toBe(`${SELF_HOSTED}/sitemap.xml`)
    expect(sitemap()[0].url).toBe(SELF_HOSTED)
  })
})

describe("the root layout's metadataBase", () => {
  it("is derived from the site URL, not a literal host", () => {
    const layout = readFileSync(path.resolve(__dirname, "../app/layout.tsx"), "utf8")
    expect(layout).toContain("metadataBase: new URL(getSiteUrl())")
    expect(layout).not.toContain("radaric.pro")
  })
})
