import type { MetadataRoute } from "next"
import { getSiteUrl } from "@/lib/site-url"

// Rendered per request: the Dockerfile builds without an app URL, so a
// build-time value would ship `localhost` in a self-hosted image.
export const dynamic = "force-dynamic"

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl()
  return [
    { url: siteUrl, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/login`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.3 },
    { url: `${siteUrl}/signup`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.5 },
    { url: `${siteUrl}/terms`, lastModified: new Date(), changeFrequency: "yearly", priority: 0.2 },
    { url: `${siteUrl}/privacy`, lastModified: new Date(), changeFrequency: "yearly", priority: 0.2 },
  ]
}
