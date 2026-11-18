/**
 * Server-side caps on the free-text prompts a user can store.
 *
 * Client-safe by design (no server imports), so a form can import the same
 * numbers the API enforces. The feed form already does — `sourceSchema` is its
 * zod resolver; the settings and onboarding forms don't, so the API is their
 * only gate.
 */

/**
 * `user_settings.globalPrompt` (PUT + PATCH) and a feed's `customPrompt`
 * (`sources.customPrompt`, via {@link sourceSchema}).
 */
export const USER_PROMPT_MAX = 8000

/** `user_settings.storySystemPrompt` — admin-only, long by nature. */
export const STORY_SYSTEM_PROMPT_MAX = 20000

/**
 * `null` when `value` is acceptable — absent, null, or a string within `max` —
 * otherwise the message the API answers with. `label` is the human name the
 * user sees ("Global prompt"), not the column name.
 *
 * Non-strings are refused rather than coerced: the columns are text, and a
 * crafted array/object must never reach Prisma.
 */
export function promptLengthError(label: string, value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") return `${label} must be a string`
  if (value.length > max) return `${label} is too long (max ${max} characters)`
  return null
}
