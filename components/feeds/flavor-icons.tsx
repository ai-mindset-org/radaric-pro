"use client"

import {
  SiSubstack,
  SiBluesky,
  SiMastodon,
  SiProducthunt,
  SiGithub,
  SiArxiv,
} from "react-icons/si"
import type { IconType } from "react-icons"
import type { FeedFlavor } from "@/lib/feed-flavor"

/**
 * Client-only flavor → icon/color map (RAD-268).
 *
 * Kept out of lib/feed-flavor.ts on purpose: the registry is imported
 * server-side (extraction, API routes, server components) and must not drag
 * react-icons into the server module graph.
 *
 * Brand hexes appear ONLY on the discovery cards — list/hero badges keep the
 * RSS tint and carry brand identity via icon + label (color is never the only
 * signal; see plan §4).
 */

export const FLAVOR_ICONS: Record<FeedFlavor, IconType> = {
  SUBSTACK: SiSubstack,
  BLUESKY: SiBluesky,
  MASTODON: SiMastodon,
  PRODUCTHUNT: SiProducthunt,
  GITHUB: SiGithub,
  ARXIV: SiArxiv,
}

export interface FlavorCardColors {
  color: string
  /** Lightened variant for dark mode when the base hex is too dark (GitHub, arXiv) */
  colorDark?: string
}

export const FLAVOR_CARD_COLORS: Record<FeedFlavor, FlavorCardColors> = {
  SUBSTACK: { color: "#FF6719" },
  BLUESKY: { color: "#0085FF" },
  MASTODON: { color: "#6364FF" },
  PRODUCTHUNT: { color: "#DA552F" },
  GITHUB: { color: "#1a211e", colorDark: "#eceeed" },
  ARXIV: { color: "#B31B1B", colorDark: "#e5484d" },
}
