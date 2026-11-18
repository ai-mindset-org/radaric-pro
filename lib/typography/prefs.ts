/**
 * Typography preferences (RAD-363) — one registry font id per role, stored as
 * JSON on `UserSettings.typography`.
 *
 * `parseTypographyPrefs` is lenient (a poisoned or partial DB row still
 * renders); `validateTypographyInput` is strict (the PATCH body must be exactly
 * the four-role object or `null`). Pure and client-safe.
 */
import { isFontId, ROLES, type FontId, type Role } from "./fonts"

export type TypographyPrefs = Record<Role, FontId>

export const DEFAULT_TYPOGRAPHY: Readonly<TypographyPrefs> = Object.freeze({
  heading: "inter",
  text: "inter",
  counter: "inter",
  tag: "inter",
})

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** A fresh prefs object: each role's own valid id, else the default. Never throws. */
export function parseTypographyPrefs(raw: unknown): TypographyPrefs {
  const prefs = { ...DEFAULT_TYPOGRAPHY }
  if (!isPlainObject(raw)) return prefs
  for (const role of ROLES) {
    if (Object.hasOwn(raw, role) && isFontId(raw[role])) prefs[role] = raw[role]
  }
  return prefs
}

/** Strict check for the PATCH body. Error strings never echo the raw value. */
export function validateTypographyInput(
  raw: unknown,
): { ok: true; value: TypographyPrefs | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null }
  const shapeError = "typography must be an object with heading, text, counter and tag"
  if (!isPlainObject(raw)) return { ok: false, error: shapeError }
  const keys = Object.keys(raw)
  if (keys.length !== ROLES.length || !ROLES.every((role) => Object.hasOwn(raw, role))) {
    return { ok: false, error: shapeError }
  }
  const value = { ...DEFAULT_TYPOGRAPHY }
  for (const role of ROLES) {
    const id = raw[role]
    if (!isFontId(id)) return { ok: false, error: `unknown font for ${role}` }
    value[role] = id
  }
  return { ok: true, value }
}
