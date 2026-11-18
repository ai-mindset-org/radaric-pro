import { z } from "zod"

export const COLLECTION_NAME_MAX = 60
export const UNSORTED_COLLECTION_NAME = "Unsorted"

export const collectionNameSchema = z
  .string()
  .trim()
  .min(1, "Name a collection")
  .max(COLLECTION_NAME_MAX)
  // Reserve the system bucket name so a user-named collection can't conflate
  // with the auto-created "Unsorted" (which would otherwise be returned by the
  // (userId, name) upsert as if the user owned it).
  .refine((n) => n.toLowerCase() !== UNSORTED_COLLECTION_NAME.toLowerCase(), {
    message: "That name is reserved",
  })

export const createCollectionSchema = z.object({
  name: collectionNameSchema,
})
export type CreateCollectionData = z.infer<typeof createCollectionSchema>

export const TRACK_QUERY_MAX = 280

/**
 * Create a self-filling collection ("tracked question"): a natural-language
 * query + cadence that spins up a backing Parallel monitor and maintains a
 * living, cited answer. `name` is the display title; `query` is what the monitor
 * actually searches for.
 */
export const trackQuestionSchema = z.object({
  name: collectionNameSchema,
  query: z.string().trim().min(1, "Describe what to track").max(TRACK_QUERY_MAX),
  cadence: z.enum(["HOURLY", "DAILY", "WEEKLY"]).default("DAILY"),
})
export type TrackQuestionData = z.infer<typeof trackQuestionSchema>

/**
 * Save a whole material. With neither field, the server resolves a smart
 * default collection. `collectionName` lets the client create-and-save in one
 * step (the toast "New collection…" path).
 */
export const saveItemSchema = z.object({
  materialId: z.string().min(1),
  collectionId: z.string().min(1).optional(),
  collectionName: collectionNameSchema.optional(),
})
export type SaveItemData = z.infer<typeof saveItemSchema>

/** Re-file a saved item/excerpt ("Move ▾"). */
export const moveSavedSchema = z
  .object({
    collectionId: z.string().min(1).optional(),
    collectionName: collectionNameSchema.optional(),
  })
  .refine((d) => Boolean(d.collectionId || d.collectionName), {
    message: "collectionId or collectionName required",
  })
export type MoveSavedData = z.infer<typeof moveSavedSchema>

/** Save a manually-highlighted passage. Offsets are into the source content. */
export const saveExcerptSchema = z
  .object({
    materialId: z.string().min(1),
    text: z.string().trim().min(1).max(5000),
    offsetStart: z.number().int().min(0),
    offsetEnd: z.number().int().min(0),
    collectionId: z.string().min(1).optional(),
    collectionName: collectionNameSchema.optional(),
  })
  .refine((d) => d.offsetEnd > d.offsetStart, {
    message: "offsetEnd must be greater than offsetStart",
  })
export type SaveExcerptData = z.infer<typeof saveExcerptSchema>
