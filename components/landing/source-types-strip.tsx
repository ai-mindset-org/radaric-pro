import {
  FaRss,
  FaTelegram,
  FaXTwitter,
  FaYoutube,
} from "react-icons/fa6"
import {
  SiArxiv,
  SiBluesky,
  SiGithub,
  SiMastodon,
  SiProducthunt,
  SiSubstack,
} from "react-icons/si"
import type { IconType } from "react-icons"

/**
 * The ten source types a curator can connect, as the compact "works with"
 * strip under the hero CTA. Event Triggers are deliberately absent: their
 * globe glyph reads as nothing in particular, and the strip's job is instant
 * recognition.
 *
 * Neutral tiles by default, so ten brands do not compete with the CTA. Hover
 * reveals the coloured pair (icon + pale tint) from the feed-type cards, in
 * 150ms — recognition without the carnival at rest.
 */

interface SourceType {
  label: string
  icon: IconType
  color: string
  colorDark?: string
  bg: string
  bgDark: string
}

const SOURCE_TYPES: SourceType[] = [
  {
    label: "RSS",
    icon: FaRss,
    color: "#f76b15",
    bg: "#f76b151f",
    bgDark: "#f76b1540",
  },
  {
    label: "Telegram",
    icon: FaTelegram,
    color: "#0090ff",
    bg: "#0090ff1f",
    bgDark: "#0090ff40",
  },
  {
    label: "X",
    icon: FaXTwitter,
    color: "#1a211e",
    colorDark: "#eceeed",
    bg: "#1a211e1a",
    bgDark: "#eceeed26",
  },
  {
    label: "YouTube",
    icon: FaYoutube,
    color: "#ff0000",
    colorDark: "#e5484d",
    bg: "#ff00001a",
    bgDark: "#e5484d33",
  },
  {
    label: "Substack",
    icon: SiSubstack,
    color: "#ff6719",
    bg: "#ff67191f",
    bgDark: "#ff671926",
  },
  {
    label: "Bluesky",
    icon: SiBluesky,
    color: "#0085ff",
    bg: "#0085ff1f",
    bgDark: "#0085ff26",
  },
  {
    label: "Mastodon",
    icon: SiMastodon,
    color: "#6364ff",
    bg: "#6364ff1f",
    bgDark: "#6364ff26",
  },
  {
    label: "Product Hunt",
    icon: SiProducthunt,
    color: "#da552f",
    bg: "#da552f1f",
    bgDark: "#da552f26",
  },
  {
    label: "GitHub",
    icon: SiGithub,
    color: "#1a211e",
    colorDark: "#eceeed",
    bg: "#1a211e1a",
    bgDark: "#eceeed26",
  },
  {
    label: "arXiv",
    icon: SiArxiv,
    color: "#b31b1b",
    colorDark: "#e5484d",
    bg: "#b31b1b1a",
    bgDark: "#e5484d26",
  },
]

export function SourceTypesStrip() {
  return (
    <ul
      aria-label="Supported source types"
      className="grid w-fit grid-cols-5 gap-1 sm:flex sm:items-center"
    >
      {SOURCE_TYPES.map((source) => {
        const Icon = source.icon
        return (
          <li key={source.label}>
            <span
              title={source.label}
              className="flex size-11 items-center justify-center rounded-md bg-secondary text-muted-foreground transition-colors duration-150 ease-out hover:bg-[var(--src-bg)] hover:text-[var(--src-color)] dark:hover:bg-[var(--src-bg-dark)] dark:hover:text-[var(--src-color-dark)]"
              style={
                {
                  "--src-color": source.color,
                  "--src-color-dark": source.colorDark ?? source.color,
                  "--src-bg": source.bg,
                  "--src-bg-dark": source.bgDark,
                } as React.CSSProperties
              }
            >
              <Icon aria-hidden className="size-[18px]" />
              <span className="sr-only">{source.label}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
