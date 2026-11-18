/**
 * RAD-369 — who may steer a story run's model and system prompt.
 *
 * The settings UI hides the story model pickers and the story system prompt
 * behind `isAdmin`, and `PUT /api/user-settings` strips them for everyone else.
 * This is the READ-time half: a row written before that guard existed (or by an
 * admin later demoted) must not steer a non-admin's run, so the ROLE decides,
 * not the row.
 *
 * Both pipeline dep factories (`pipeline-deps.ts`) and the worker's retry
 * daemon use this module, so the paths cannot drift apart. `worker.ts` is not
 * admin-only — it re-runs every user's ERROR inbox items.
 */

/** A row shape that carries the story system prompt the pipeline reads. */
export type StorySettingsRow = { storySystemPrompt: string | null }

/** Masks the story settings a pipeline dep is allowed to see. */
export type SettingsShaper = <T extends StorySettingsRow>(row: T | null) => T | null

/**
 * The entitlement for one run. `role` is `User.role`; anything but "ADMIN" —
 * including a missing user row — is a non-admin.
 */
export function storyOverridesFor(role: string | null | undefined) {
  const isAdmin = role === "ADMIN"
  return {
    /** The stored per-stage override the resolver may use. */
    model: (stored: string | null | undefined): string | null =>
      isAdmin ? (stored ?? null) : null,
    /** The row as the pipeline may see it — the system prompt is masked. */
    settings: <T extends StorySettingsRow>(row: T | null): T | null =>
      row && !isAdmin ? { ...row, storySystemPrompt: null } : row,
  }
}
