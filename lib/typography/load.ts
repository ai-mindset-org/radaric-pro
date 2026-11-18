/**
 * server-only — reads the per-user typography preference (RAD-363).
 *
 * Never rejects: no user, no row, a malformed value or a database error all
 * resolve to the default, so rendering never fails because of this column.
 */
import { db } from "@/lib/db"
import { DEFAULT_TYPOGRAPHY, parseTypographyPrefs, type TypographyPrefs } from "./prefs"

export async function loadTypography(userId: string | undefined | null): Promise<TypographyPrefs> {
  if (!userId) return { ...DEFAULT_TYPOGRAPHY }
  try {
    const row = await db.userSettings.findUnique({
      where: { userId },
      select: { typography: true },
    })
    return parseTypographyPrefs(row?.typography)
  } catch (error) {
    console.error("[typography] failed to load preferences", error)
    return { ...DEFAULT_TYPOGRAPHY }
  }
}
