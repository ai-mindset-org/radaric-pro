/**
 * The per-user Notion integration token, sealed at rest (RAD-221). Every read
 * of `user_settings.notion_token` that hands the value to Notion goes through
 * `openNotionToken`; presence checks (`!!row.notionToken`) need no key and stay
 * as they are. The only writer is PUT /api/user-settings, through
 * `sealNotionToken`. The value never leaves the server (RAD-380).
 */

import { TOKEN_PURPOSE, decryptToken, encryptToken } from "@/lib/token-crypto"

export function sealNotionToken(plaintext: string, userId: string): string {
  return encryptToken(plaintext, TOKEN_PURPOSE.userNotionToken, userId)
}

/** The usable token. Throws when the stored value cannot be opened. */
export function openNotionToken(stored: string, userId: string): string {
  return decryptToken(stored, TOKEN_PURPOSE.userNotionToken, userId)
}

/**
 * For paths where Notion is optional (story polling, a post's story run): a
 * token that does not open means "no Notion export" for this run instead of a
 * failed run. Logs the reason, never the value.
 */
export function openNotionTokenOrEmpty(stored: string | null | undefined, userId: string, context: string): string {
  if (!stored) return ""
  try {
    return openNotionToken(stored, userId)
  } catch (error) {
    console.error(`[${context}] Notion token unavailable for user ${userId}:`, (error as Error).message)
    return ""
  }
}
