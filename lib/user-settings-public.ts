/**
 * The shape of a `user_settings` row that may leave the server (RAD-380).
 *
 * Allowlist, not denylist: a new column stays server-side until someone adds
 * it here. `__tests__/api/user-settings-token-never-leaves.test.ts` fails when
 * a column is in neither list, so the choice is made at review time.
 */

import type { UserSettings } from "@prisma/client"

export const PUBLIC_USER_SETTINGS_FIELDS = [
  "id",
  "userId",
  "globalPrompt",
  "notionDatabaseId",
  "storyInboxChannelId",
  "storyNotionDatabaseId",
  "storyLastMessageId",
  "storySystemPrompt",
  "storyPromptVersion",
  "storyWriterModel",
  "storyMatcherModel",
  "materialStoryModel",
  "storyLanguage",
  "autoDeleteTelegramMessages",
  "globalLikedCategories",
  "globalDislikedCategories",
  "onboardingCompleted",
  "onboardingBannerDismissed",
  "onboardingState",
  "typography",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof UserSettings)[]

/** Columns that never leave the server, in any form (plaintext or sealed). */
export const SECRET_USER_SETTINGS_FIELDS = ["notionToken"] as const satisfies readonly (keyof UserSettings)[]

export type PublicUserSettings = Pick<UserSettings, (typeof PUBLIC_USER_SETTINGS_FIELDS)[number]> & {
  /** Whether a Notion integration token is stored. The token itself stays on the server. */
  hasNotionToken: boolean
}

export function toPublicUserSettings(row: UserSettings): PublicUserSettings {
  const out: Record<string, unknown> = {}
  for (const field of PUBLIC_USER_SETTINGS_FIELDS) {
    if (field in row) out[field] = row[field]
  }
  out.hasNotionToken = Boolean(row.notionToken)
  return out as PublicUserSettings
}
