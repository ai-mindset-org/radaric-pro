/** Typography presets (RAD-363) — the one-click chips in Settings. */
import { ROLES } from "./fonts"
import type { TypographyPrefs } from "./prefs"

export type PresetId = "inter" | "martian" | "apple" | "pt-root" | "plex"

export interface TypographyPreset {
  id: PresetId
  label: string
  prefs: TypographyPrefs
}

export const PRESETS: readonly TypographyPreset[] = [
  {
    id: "inter",
    label: "Inter",
    prefs: { heading: "inter", text: "inter", counter: "inter", tag: "inter" },
  },
  {
    id: "martian",
    label: "Martian",
    prefs: { heading: "martian-grotesk", text: "martian-grotesk", counter: "martian-mono", tag: "martian-grotesk" },
  },
  {
    id: "apple",
    label: "Apple",
    prefs: { heading: "sf-pro", text: "sf-pro", counter: "sf-mono", tag: "sf-pro" },
  },
  {
    id: "pt-root",
    label: "PT Root",
    prefs: { heading: "pt-root-ui", text: "pt-root-ui", counter: "martian-mono", tag: "pt-root-ui" },
  },
  {
    id: "plex",
    label: "Plex",
    prefs: { heading: "ibm-plex-sans", text: "ibm-plex-sans", counter: "ibm-plex-mono", tag: "ibm-plex-sans" },
  },
]

/** The preset whose four roles all equal `prefs`, else null. */
export function matchPreset(prefs: TypographyPrefs): PresetId | null {
  const match = PRESETS.find((p) => ROLES.every((role) => p.prefs[role] === prefs[role]))
  return match ? match.id : null
}
