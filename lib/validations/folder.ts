import { z } from "zod"

/** Sidebar folder names: trimmed, 1–60 chars, unique per user (case-insensitive). */
export const FOLDER_NAME_MAX = 60

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, "Folder name is required")
  .max(FOLDER_NAME_MAX, `Folder name must be at most ${FOLDER_NAME_MAX} characters`)

export const folderBodySchema = z.object({
  name: folderNameSchema,
})

export const folderMoveBodySchema = z.object({
  folderId: z.string().min(1).nullable(),
})

/**
 * The DB uniqueness key. Stored alongside the display name and enforced by
 * `@@unique([userId, nameLower])` — no read-then-write race, no functional-index
 * drift. NFC normalization + `toLowerCase()` fold Cyrillic correctly; exotic
 * locale edge cases are accepted (see the RAD-393 plan).
 */
export function folderNameLower(name: string): string {
  return name.trim().normalize("NFC").toLowerCase()
}

/** Prisma P2002, duck-typed so unit tests can throw a plain object. */
export function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  )
}
