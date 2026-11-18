/**
 * Typography registry (RAD-363) — the eleven pickable fonts, the four roles
 * they can fill, and the CSS `font-family` stack each font resolves to.
 *
 * Pure and client-safe: strings only. Face ids name entries in
 * `font-metrics.json`; the adaptation numbers for a face live in `./derive`.
 */

export type FontId =
  | "inter"
  | "martian-grotesk"
  | "pt-root-ui"
  | "golos-text"
  | "ibm-plex-sans"
  | "sf-pro"
  | "sf-pro-rounded"
  | "martian-mono"
  | "jetbrains-mono"
  | "ibm-plex-mono"
  | "sf-mono"

export type Role = "heading" | "text" | "counter" | "tag"

export interface FontEntry {
  label: string
  group: "sans" | "mono"
  source: "self-hosted" | "system"
  availability: "everywhere" | "apple" | "apple-safari"
  faces: { standard: string; narrow: string }
}

/** Picker order. */
export const FONT_IDS: readonly FontId[] = [
  "inter",
  "martian-grotesk",
  "pt-root-ui",
  "golos-text",
  "ibm-plex-sans",
  "sf-pro",
  "sf-pro-rounded",
  "martian-mono",
  "jetbrains-mono",
  "ibm-plex-mono",
  "sf-mono",
]

export const ROLES: readonly Role[] = ["heading", "text", "counter", "tag"]

const same = (face: string) => ({ standard: face, narrow: face })

/** Typed by string so callers can index with unvalidated ids; `satisfies` keeps it exhaustive over FontId. */
export const FONTS: Record<string, FontEntry> = {
  inter: {
    label: "Inter",
    group: "sans",
    source: "self-hosted",
    availability: "everywhere",
    faces: same("inter"),
  },
  "martian-grotesk": {
    label: "Martian Grotesk",
    group: "sans",
    source: "self-hosted",
    availability: "everywhere",
    faces: { standard: "martian-grotesk", narrow: "martian-grotesk-narrow" },
  },
  "pt-root-ui": {
    label: "PT Root UI",
    group: "sans",
    source: "self-hosted",
    availability: "everywhere",
    faces: same("pt-root-ui"),
  },
  "golos-text": {
    label: "Golos Text",
    group: "sans",
    source: "self-hosted",
    availability: "everywhere",
    faces: same("golos-text"),
  },
  "ibm-plex-sans": {
    label: "IBM Plex Sans",
    group: "sans",
    source: "self-hosted",
    availability: "everywhere",
    faces: same("ibm-plex-sans"),
  },
  "sf-pro": {
    label: "SF Pro",
    group: "sans",
    source: "system",
    availability: "apple",
    faces: same("sf-pro"),
  },
  "sf-pro-rounded": {
    label: "SF Pro Rounded",
    group: "sans",
    source: "system",
    availability: "apple-safari",
    faces: same("sf-pro-rounded"),
  },
  "martian-mono": {
    label: "Martian Mono",
    group: "mono",
    source: "self-hosted",
    availability: "everywhere",
    faces: { standard: "martian-mono", narrow: "martian-mono-narrow" },
  },
  "jetbrains-mono": {
    label: "JetBrains Mono",
    group: "mono",
    source: "self-hosted",
    availability: "everywhere",
    faces: same("jetbrains-mono"),
  },
  "ibm-plex-mono": {
    label: "IBM Plex Mono",
    group: "mono",
    source: "self-hosted",
    availability: "everywhere",
    faces: same("ibm-plex-mono"),
  },
  "sf-mono": {
    label: "SF Mono",
    group: "mono",
    source: "system",
    availability: "apple",
    faces: same("sf-mono"),
  },
} satisfies Record<FontId, FontEntry>

/** The face that supplies tabular digits for a font that has none of its own. */
export const FIGURES_FACE: Record<string, string> = {
  "martian-grotesk": "martian-mono-narrow",
}

const STACKS: Record<FontId, string> = {
  inter: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
  "martian-grotesk": '"Radaric Martian Grotesk", var(--font-inter), system-ui, sans-serif',
  "pt-root-ui": '"Radaric PT Root UI", var(--font-inter), system-ui, sans-serif',
  "golos-text": '"Radaric Golos Text", var(--font-inter), system-ui, sans-serif',
  "ibm-plex-sans": '"Radaric IBM Plex Sans", var(--font-inter), system-ui, sans-serif',
  "sf-pro": "-apple-system, BlinkMacSystemFont, var(--font-inter), sans-serif",
  "sf-pro-rounded":
    'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, var(--font-inter), sans-serif',
  "martian-mono": '"Radaric Martian Mono", ui-monospace, Menlo, monospace',
  "jetbrains-mono": '"Radaric JetBrains Mono", ui-monospace, Menlo, monospace',
  "ibm-plex-mono": '"Radaric IBM Plex Mono", ui-monospace, Menlo, monospace',
  "sf-mono": 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
}

/** Family names of the figures-only faces, prepended to counter stacks. */
const FIGURES_FAMILY: Record<string, string> = {
  "martian-grotesk": '"Radaric Martian Grotesk Figures"',
}

const FONT_ID_SET: ReadonlySet<string> = new Set(FONT_IDS)
const ROLE_SET: ReadonlySet<string> = new Set(ROLES)

/** True only for a registry id — own entries, never `Object.prototype` names. */
export function isFontId(value: unknown): value is FontId {
  return typeof value === "string" && FONT_ID_SET.has(value)
}

/** True only for one of the four roles. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value)
}

/** The CSS `font-family` list for a font in a role. */
export function fontStack(fontId: string, role: string): string {
  if (!isFontId(fontId)) throw new Error(`Unknown font id: ${fontId}`)
  const stack = STACKS[fontId]
  const figures =
    role === "counter" && Object.hasOwn(FIGURES_FAMILY, fontId) ? FIGURES_FAMILY[fontId] : undefined
  return figures ? `${figures}, ${stack}` : stack
}
