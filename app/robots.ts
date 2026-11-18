import type { MetadataRoute } from "next"
import { getSiteUrl } from "@/lib/site-url"

// Rendered per request: the Dockerfile builds without an app URL, so a
// build-time value would ship `localhost` in a self-hosted image.
export const dynamic = "force-dynamic"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/posts", "/feeds", "/rules", "/settings", "/stories"],
    },
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  }
}
