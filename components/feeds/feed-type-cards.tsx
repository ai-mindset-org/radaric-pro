"use client"

import Link from "next/link"
import { Lock } from "lucide-react"
import { FaRss, FaTelegram, FaXTwitter, FaYoutube } from "react-icons/fa6"
import { TbWorldSearch } from "react-icons/tb"
import type { IconType } from "react-icons"
import { FEED_FLAVORS, FLAVOR_CONFIGS, type FeedFlavor } from "@/lib/feed-flavor"
import { FLAVOR_ICONS, FLAVOR_CARD_COLORS } from "@/components/feeds/flavor-icons"

interface SourceTypeConfig {
  type: string
  label: string
  icon: IconType
  color: string
  colorDark?: string
  borderColor: string
  borderColorHover: string
  borderColorDark?: string
  borderColorHoverDark?: string
  glowColor: string
  glowColorDark: string
  iconBg: string
  iconBgDark: string
}

const SOURCE_TYPES: SourceTypeConfig[] = [
  {
    type: "RSS",
    label: "Add RSS",
    icon: FaRss,
    color: "#f76b15",
    borderColor: "#f76b1533",
    borderColorHover: "#f76b1566",
    glowColor: "#f76b1533",
    glowColorDark: "#f76b154d",
    iconBg: "#f76b151f",
    iconBgDark: "#f76b1540",
  },
  {
    type: "TELEGRAM",
    label: "Add Telegram",
    icon: FaTelegram,
    color: "#0090ff",
    borderColor: "#0090ff33",
    borderColorHover: "#0090ff66",
    glowColor: "#0090ff33",
    glowColorDark: "#0090ff4d",
    iconBg: "#0090ff1f",
    iconBgDark: "#0090ff40",
  },
  {
    type: "TWITTER",
    label: "Add X",
    icon: FaXTwitter,
    color: "#1a211e",
    colorDark: "#eceeed",
    borderColor: "#1a211e33",
    borderColorHover: "#1a211e59",
    borderColorDark: "#eceeed26",
    borderColorHoverDark: "#eceeed4d",
    glowColor: "#1a211e1f",
    glowColorDark: "#eceeed26",
    iconBg: "#1a211e1a",
    iconBgDark: "#eceeed26",
  },
  {
    // Brand #FF0000 only here, as the icon glyph (graphical mark, 3:1 UI bar);
    // red-as-text elsewhere uses the token idiom in feed-type-color.ts.
    // Dark variant is the arXiv Radix red — pure red glares on OLED.
    type: "YOUTUBE",
    label: "Add YouTube",
    icon: FaYoutube,
    color: "#FF0000",
    colorDark: "#e5484d",
    borderColor: "#ff000033",
    borderColorHover: "#ff000059",
    borderColorDark: "#e5484d33",
    borderColorHoverDark: "#e5484d59",
    glowColor: "#ff000026",
    glowColorDark: "#e5484d4d",
    iconBg: "#ff00001a",
    iconBgDark: "#e5484d33",
  },
  {
    type: "EVENT_TRIGGER",
    label: "Add Event Trigger",
    icon: TbWorldSearch,
    color: "#8e4ec6",
    borderColor: "#8e4ec633",
    borderColorHover: "#8e4ec666",
    glowColor: "#8e4ec633",
    glowColorDark: "#8e4ec64d",
    iconBg: "#8e4ec61f",
    iconBgDark: "#8e4ec640",
  },
]

export function FeedTypeCards({ includesTwitter = true }: { includesTwitter?: boolean }) {
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {SOURCE_TYPES.map((source) => (
          <SourceTypeCard
            key={source.type}
            {...source}
            locked={source.type === "TWITTER" && !includesTwitter}
          />
        ))}
      </div>

      {/* Branded RSS presets (RAD-268) — deliberately lighter than the type
          cards above (no glow, smaller) so they read as a subset of RSS,
          not as six more source types. */}
      <div className="mt-4 h-px bg-border/60" aria-hidden="true" />
      <div className="mt-3 flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-foreground/70">Popular sources</h2>
        <span className="text-xs text-muted-foreground">All connect via RSS</span>
      </div>
      <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2">
        {FEED_FLAVORS.map((flavor) => (
          <BrandSourceCard key={flavor} flavor={flavor} />
        ))}
      </div>
    </div>
  )
}

function BrandSourceCard({ flavor }: { flavor: FeedFlavor }) {
  const config = FLAVOR_CONFIGS[flavor]
  const colors = FLAVOR_CARD_COLORS[flavor]
  const Icon = FLAVOR_ICONS[flavor]

  return (
    <Link
      href={`/feeds/new?type=RSS&flavor=${flavor}`}
      className="group flex min-h-[76px] flex-col items-center justify-center gap-2 rounded-xl bg-secondary/40 px-2 py-3 text-center transition-colors duration-200 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
      style={
        {
          "--brand-color": colors.color,
          "--brand-color-dark": colors.colorDark || colors.color,
          "--brand-chip-bg": `${colors.color}1f`,
          "--brand-chip-bg-dark": `${colors.colorDark || colors.color}26`,
        } as React.CSSProperties
      }
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--brand-chip-bg)] dark:bg-[var(--brand-chip-bg-dark)]">
        <Icon
          className="h-[16px] w-[16px] text-[var(--brand-color)] dark:text-[var(--brand-color-dark)]"
          aria-hidden="true"
        />
      </span>
      <span className="text-xs font-medium text-foreground/70 transition-colors duration-200 group-hover:text-foreground">
        {config.label}
      </span>
    </Link>
  )
}

function SourceTypeCard({
  type,
  label,
  icon: Icon,
  color,
  colorDark,
  borderColor,
  borderColorHover,
  borderColorDark,
  borderColorHoverDark,
  glowColor,
  glowColorDark,
  iconBg,
  iconBgDark,
  locked = false,
}: SourceTypeConfig & { locked?: boolean }) {
  return (
    <Link
      href={`/feeds/new?type=${type}`}
      aria-label={locked ? `${label} — requires Radaric Pro` : undefined}
      className="source-type-card group relative rounded-2xl py-6 px-4 transition-colors duration-200 flex flex-col items-center gap-3 text-center"
      style={
        {
          "--card-color": color,
          "--card-color-dark": colorDark || color,
          "--card-border": borderColor,
          "--card-border-hover": borderColorHover,
          ...(borderColorDark && { "--card-border-dark": borderColorDark }),
          ...(borderColorHoverDark && { "--card-border-hover-dark": borderColorHoverDark }),
          "--card-glow": glowColor,
          "--card-glow-dark": glowColorDark,
          "--card-icon-bg": iconBg,
          "--card-icon-bg-dark": iconBgDark,
        } as React.CSSProperties
      }
    >
      {/* Glow blob */}
      <div
        className="surface-mask pointer-events-none absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <div className="source-type-glow h-[140px] w-[140px] rounded-full blur-[70px]" />
      </div>

      {/* Pro lock badge — non-color-only signal that this source needs Pro */}
      {locked && (
        <span className="type-tag absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-xs bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
          <Lock className="h-3 w-3" aria-hidden="true" />
          Pro
        </span>
      )}

      {/* Icon */}
      <div className="source-type-icon-wrap relative z-10 flex h-[48px] w-[48px] items-center justify-center rounded-full transition-transform group-hover:scale-105">
        <Icon
          className="source-type-icon h-[24px] w-[24px]"
          aria-hidden="true"
        />
      </div>

      {/* Label */}
      <span className="relative z-10 text-sm font-medium text-foreground/70 group-hover:text-foreground transition-colors duration-200">
        {label}
      </span>
    </Link>
  )
}
