import { db } from "@/lib/db"
import { UNSORTED_COLLECTION_NAME } from "@/lib/validations/saved"

/**
 * Get-or-create the user's system "Unsorted" collection — the always-present
 * landing bucket so a one-tap save never falls into a void. Upsert on the
 * (userId, name) unique to be race-safe.
 */
export async function ensureUnsorted(userId: string) {
  return db.collection.upsert({
    where: { userId_name: { userId, name: UNSORTED_COLLECTION_NAME } },
    update: { isSystem: true },
    create: { userId, name: UNSORTED_COLLECTION_NAME, isSystem: true },
  })
}

/**
 * Smart-default collection for a new save: the collection the user most
 * recently saved into (session-sticky — a topic sweep stays in one bucket),
 * else the "Unsorted" system collection. Deterministic; no AI.
 */
export async function resolveDefaultCollectionId(userId: string): Promise<string> {
  const recent = await db.savedItem.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { collectionId: true },
  })
  if (recent) return recent.collectionId
  const unsorted = await ensureUnsorted(userId)
  return unsorted.id
}

/**
 * Resolve the target collection for a save/move from optional inputs:
 * - `collectionName` → get-or-create that named collection (the "New
 *   collection…" path);
 * - `collectionId` → use it iff the user owns it (else null = forbidden);
 * - neither → the smart default.
 * Returns a collection id, or null when an explicit id is not owned.
 */
export async function resolveTargetCollectionId(
  userId: string,
  opts: { collectionId?: string; collectionName?: string }
): Promise<string | null> {
  if (opts.collectionName) {
    const col = await db.collection.upsert({
      where: { userId_name: { userId, name: opts.collectionName } },
      update: {},
      create: { userId, name: opts.collectionName },
    })
    return col.id
  }
  if (opts.collectionId) {
    const col = await db.collection.findFirst({
      where: { id: opts.collectionId, userId },
      select: { id: true },
    })
    return col?.id ?? null
  }
  return resolveDefaultCollectionId(userId)
}
