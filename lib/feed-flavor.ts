/**
 * Branded RSS presets — the flavor registry (RAD-268).
 *
 * A "flavor" is a presentation-level brand identity for feeds that are plain
 * `type: RSS` under the hood (Substack, Bluesky, Mastodon, Product Hunt,
 * GitHub, arXiv). Nothing is stored: flavor is derived on read from Feed.url
 * via detectFlavor(). This module is isomorphic and pure — strings only, no
 * React, no icons (the flavor → icon/color map lives in a client leaf,
 * components/feeds/flavor-icons.tsx).
 *
 * Feed URL formats (source of truth, verified live 2026-07-02):
 * - Substack:      https://<pub>.substack.com/feed   (custom domains undetectable — they still work as plain RSS)
 * - Bluesky:       https://bsky.app/profile/<handle>/rss
 * - Mastodon:      https://<instance>/@<user>.rss    (heuristic; resolution is form-only — see resolveBrandUrl)
 * - Product Hunt:  https://www.producthunt.com/feed[?category=<slug>]
 * - GitHub:        https://github.com/<owner>/<repo>/releases.atom (commits/tags .atom also recognized)
 * - arXiv:         https://rss.arxiv.org/rss/<category>
 */

export const FEED_FLAVORS = [
  "SUBSTACK",
  "BLUESKY",
  "MASTODON",
  "PRODUCTHUNT",
  "GITHUB",
  "ARXIV",
] as const

export type FeedFlavor = (typeof FEED_FLAVORS)[number]

export interface FlavorConfig {
  flavor: FeedFlavor
  label: string
  placeholder: string
  helpText: string
  /** Product Hunt: empty input resolves to the general launches feed */
  inputOptional?: boolean
}

export const FLAVOR_CONFIGS: Record<FeedFlavor, FlavorConfig> = {
  SUBSTACK: {
    flavor: "SUBSTACK",
    label: "Substack",
    placeholder: "stratechery.substack.com",
    helpText:
      "Paste the publication URL. Substacks on a custom domain: paste their /feed URL into the feed URL field below.",
  },
  BLUESKY: {
    flavor: "BLUESKY",
    label: "Bluesky",
    placeholder: "@handle.bsky.social or profile URL",
    helpText: "Any Bluesky handle works, including custom domains.",
  },
  MASTODON: {
    flavor: "MASTODON",
    label: "Mastodon",
    placeholder: "@user@instance or profile URL",
    helpText: "Paste the profile URL (e.g. mastodon.social/@user) or the full @user@instance handle.",
  },
  PRODUCTHUNT: {
    flavor: "PRODUCTHUNT",
    label: "Product Hunt",
    placeholder: "Topic slug (optional), e.g. artificial-intelligence",
    helpText: "Leave empty for all launches, or enter a topic slug for one category.",
    inputOptional: true,
  },
  GITHUB: {
    flavor: "GITHUB",
    label: "GitHub",
    placeholder: "owner/repo, e.g. vercel/next.js",
    helpText: "Follows the repository's releases feed.",
  },
  ARXIV: {
    flavor: "ARXIV",
    label: "arXiv",
    placeholder: "Category, e.g. cs.AI",
    helpText: "arXiv category code (cs.AI, econ.EM, hep-th, …).",
  },
}

export function isFeedFlavor(value: string | null | undefined): value is FeedFlavor {
  return typeof value === "string" && (FEED_FLAVORS as readonly string[]).includes(value)
}

export interface ResolvedFlavorInput {
  url: string
  name?: string
}

function toUrl(input: string): URL | null {
  const s = input.trim()
  if (!s) return null
  try {
    return new URL(s)
  } catch {
    try {
      return new URL(`https://${s}`)
    } catch {
      return null
    }
  }
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean)
}

function resolveSubstack(input: string): ResolvedFlavorInput | null {
  const s = input.trim().replace(/^@/, "")
  // Bare publication name (no dot, no slash) → <name>.substack.com
  if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(s)) {
    const pub = s.toLowerCase()
    return { url: `https://${pub}.substack.com/feed`, name: pub }
  }
  const url = toUrl(s)
  if (!url || !url.hostname.endsWith(".substack.com")) return null
  return {
    url: `https://${url.hostname}/feed`,
    name: url.hostname.split(".")[0],
  }
}

function resolveBluesky(input: string): ResolvedFlavorInput | null {
  const s = input.trim()
  if (!s) return null

  let handle: string | null = null

  const url = toUrl(s)
  if (url && url.hostname === "bsky.app") {
    const match = url.pathname.match(/^\/profile\/([^/]+)(?:\/rss)?\/?$/)
    if (!match) return null
    handle = match[1]
  } else if (url && s.includes("/")) {
    // Some other site's URL — not a handle
    return null
  } else {
    const bare = s.replace(/^@/, "")
    if (!/^[A-Za-z0-9][\w.-]*$/.test(bare)) return null
    handle = bare.includes(".") ? bare : `${bare}.bsky.social`
  }

  return {
    url: `https://bsky.app/profile/${handle}/rss`,
    name: `@${handle}`,
  }
}

function resolveMastodon(input: string): ResolvedFlavorInput | null {
  const s = input.trim()
  if (!s) return null

  // Webfinger form: @user@instance (leading @ optional)
  const webfinger = s.match(/^@?([\w.-]+)@([\w-]+(?:\.[\w-]+)+)$/)
  if (webfinger) {
    return {
      url: `https://${webfinger[2]}/@${webfinger[1]}.rss`,
      name: `@${webfinger[1]}@${webfinger[2]}`,
    }
  }

  // Profile URL form: https://instance/@user[.rss]
  const url = toUrl(s)
  if (!url) return null
  const match = url.pathname.match(/^\/@([\w.-]+?)(\.rss)?\/?$/)
  if (!match) return null
  return {
    url: `https://${url.hostname}/@${match[1]}.rss`,
    name: `@${match[1]}@${url.hostname}`,
  }
}

function resolveProductHunt(input: string): ResolvedFlavorInput | null {
  const s = input.trim()
  if (!s) {
    return { url: "https://www.producthunt.com/feed", name: "Product Hunt" }
  }

  if (s.includes("producthunt.com")) {
    const url = toUrl(s)
    if (!url || !/(^|\.)producthunt\.com$/.test(url.hostname)) return null
    const segments = pathSegments(url)
    if (segments.length === 0) {
      return { url: "https://www.producthunt.com/feed", name: "Product Hunt" }
    }
    if (segments[0] === "feed") {
      return {
        url: `https://www.producthunt.com/feed${url.search}`,
        name: "Product Hunt",
      }
    }
    if (segments[0] === "topics" && segments[1]) {
      return {
        url: `https://www.producthunt.com/feed?category=${segments[1]}`,
        name: `Product Hunt: ${segments[1]}`,
      }
    }
    return null
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(s)) return null
  return {
    url: `https://www.producthunt.com/feed?category=${s.toLowerCase()}`,
    name: `Product Hunt: ${s.toLowerCase()}`,
  }
}

function resolveGitHub(input: string): ResolvedFlavorInput | null {
  const s = input.trim()
  if (!s) return null

  let segments: string[] | null = null

  if (s.includes("github.com")) {
    const url = toUrl(s)
    if (!url || url.hostname !== "github.com") return null
    segments = pathSegments(url)
  } else {
    const shorthand = s.match(/^([\w.-]+)\/([\w.-]+)$/)
    if (!shorthand) return null
    segments = [shorthand[1], shorthand[2]]
  }

  if (!segments || segments.length < 2) return null

  // Explicit .atom feed (releases/commits/tags) — keep as-is
  if (segments[segments.length - 1].endsWith(".atom")) {
    return {
      url: `https://github.com/${segments.join("/")}`,
      name: `${segments[0]}/${segments[1]}`,
    }
  }

  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/, "")
  return {
    url: `https://github.com/${owner}/${repo}/releases.atom`,
    name: `${owner}/${repo}`,
  }
}

function resolveArxiv(input: string): ResolvedFlavorInput | null {
  const s = input.trim()
  if (!s) return null

  let category: string | null = null

  if (s.includes("arxiv.org")) {
    const url = toUrl(s)
    if (!url || !/(^|\.)arxiv\.org$/.test(url.hostname)) return null
    const segments = pathSegments(url)
    if ((segments[0] === "rss" || segments[0] === "list") && segments[1]) {
      category = segments[1]
    } else {
      return null
    }
  } else if (/^[a-z-]+(\.[A-Za-z-]+)?$/.test(s)) {
    category = s
  } else {
    return null
  }

  return {
    url: `https://rss.arxiv.org/rss/${category}`,
    name: `arXiv ${category}`,
  }
}

const RESOLVERS: Record<FeedFlavor, (input: string) => ResolvedFlavorInput | null> = {
  SUBSTACK: resolveSubstack,
  BLUESKY: resolveBluesky,
  MASTODON: resolveMastodon,
  PRODUCTHUNT: resolveProductHunt,
  GITHUB: resolveGitHub,
  ARXIV: resolveArxiv,
}

/**
 * Form path: the flavor is known (user picked a brand card), the input may be
 * a handle, slug, or URL. Returns the final feed URL + a suggested feed name.
 */
export function resolveFlavorInput(flavor: FeedFlavor, input: string): ResolvedFlavorInput | null {
  return RESOLVERS[flavor](input)
}

/**
 * Extraction path: URL-only, tried against pasted URLs in bulk-add/onboarding.
 * Deliberately excludes MASTODON — its `/@user` heuristic would falsely match
 * Medium and other profile URLs whose real feed the existing WEBSITE→discovery
 * probe finds correctly.
 */
export function resolveBrandUrl(
  input: string
): (ResolvedFlavorInput & { flavor: FeedFlavor }) | null {
  const url = toUrl(input)
  if (!url) return null
  const host = url.hostname

  let flavor: FeedFlavor | null = null
  if (host.endsWith(".substack.com")) flavor = "SUBSTACK"
  else if (host === "bsky.app") flavor = "BLUESKY"
  else if (host === "github.com") flavor = "GITHUB"
  else if (/(^|\.)producthunt\.com$/.test(host)) flavor = "PRODUCTHUNT"
  else if (/(^|\.)arxiv\.org$/.test(host)) flavor = "ARXIV"
  if (!flavor) return null

  const resolved = RESOLVERS[flavor](input)
  return resolved ? { ...resolved, flavor } : null
}

/**
 * Render path: pattern-match a final feed URL back to a flavor.
 * Pure and cheap — called on read wherever brand identity is displayed.
 */
export function detectFlavor(feedUrl: string): FeedFlavor | null {
  const url = toUrl(feedUrl)
  if (!url) return null
  const host = url.hostname
  const path = url.pathname

  if (host.endsWith(".substack.com") && path.startsWith("/feed")) return "SUBSTACK"
  if (host === "bsky.app" && /^\/profile\/[^/]+\/rss\/?$/.test(path)) return "BLUESKY"
  if (/^\/@[\w.-]+\.rss$/.test(path)) return "MASTODON"
  if (/(^|\.)producthunt\.com$/.test(host) && path.startsWith("/feed")) return "PRODUCTHUNT"
  if (host === "github.com" && path.endsWith(".atom")) return "GITHUB"
  if (host === "rss.arxiv.org" && path.startsWith("/rss/")) return "ARXIV"

  return null
}
