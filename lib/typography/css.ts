/**
 * Per-user typography CSS (RAD-363) — remaps each changed role's variables onto
 * the static per-font token bundles (`--f-<fontId>-<role>-<token>`).
 *
 * The output is rendered inside an unlayered `<style>`, so it must never carry
 * raw input: the prefs are parsed first and every id interpolated here comes
 * from the registry. Client-safe — no `./derive`, no metrics JSON.
 */
import { isFontId, ROLES } from "./fonts"
import { DEFAULT_TYPOGRAPHY, parseTypographyPrefs, type TypographyPrefs } from "./prefs"

export const ROLE_TOKENS = [
  "family",
  "stretch",
  "wa",
  "wb",
  "size-adjust",
  "caps-adjust",
  "features",
  "df",
  "cf",
  "leading",
] as const

export type RoleToken = (typeof ROLE_TOKENS)[number]

/** One `:root{…}` rule for the roles that differ from the default; `""` when none do. */
export function buildTypographyCss(prefs: TypographyPrefs): string {
  const parsed = parseTypographyPrefs(prefs)
  const declarations = ROLES.filter((role) => parsed[role] !== DEFAULT_TYPOGRAPHY[role]).flatMap((role) =>
    ROLE_TOKENS.map((token) => `--type-${role}-${token}:var(--f-${parsed[role]}-${role}-${token})`),
  )
  return declarations.length === 0 ? "" : `:root{${declarations.join(";")}}`
}

/** Inline style that sets a picker option in its own font (RAD-363 slice 7). */
export function fontPreviewStyle(id: string): import("react").CSSProperties {
  if (!isFontId(id)) throw new Error(`Unknown font id: ${id}`)
  return {
    fontFamily: `var(--f-${id}-text-family)`,
    fontStretch: `var(--f-${id}-text-stretch)`,
    fontSizeAdjust: `var(--f-${id}-text-size-adjust)`,
    fontFeatureSettings: `var(--f-${id}-text-features)`,
    fontWeight: `calc(400 * var(--f-${id}-text-wa) + var(--f-${id}-text-wb))`,
  }
}
