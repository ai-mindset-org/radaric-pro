// @vitest-environment node

/**
 * RAD-368 — a per-user material delete must never delete R2 objects.
 *
 * The only objects Radaric ever writes to R2 are Telegram media under
 * `telegram/<channel>/<messageId>.<ext>`, and uploads dedupe by key
 * (`r2ObjectExists`): ONE object is shared by every user subscribed to the
 * channel. `DELETE /api/posts/[id]` used to delete every object named in the
 * material's `mediaUrls` + `thumbnailUrl`, so an ordinary user tidying their
 * inbox removed the image for every other subscriber. Worse, `extractR2Key`
 * trusted ANY `*.r2.dev` host and matched `R2_PUBLIC_URL` with `startsWith`, so
 * a feed item carrying `https://anything.r2.dev/telegram/<channel>/<id>.jpg`
 * let the material's owner name our keys.
 *
 * Contracts after the fix:
 *   AC-1 — deleting an owned material takes it out of the inbox and sends no
 *          R2 delete at all
 *   AC-2 — two users referencing the same telegram key: deleting one leaves the
 *          object alone for the other
 *   AC-3 — only the exact host of `R2_PUBLIC_URL` is managed storage (no
 *          `*.r2.dev` suffix trust, no `startsWith` prefix trust)
 *   AC-4 — `deleteTelegramMedia` on a foreign host sends no DeleteObjectCommand
 *
 * The S3 boundary is mocked at the SDK module, so `lib/blob-storage` runs its
 * real key extraction and a delete would be observable as a captured
 * DeleteObjectCommand input.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const { deleteInputs, sendMock } = vi.hoisted(() => ({
  deleteInputs: [] as Array<Record<string, unknown>>,
  sendMock: vi.fn(async () => ({})),
}))

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }
  class DeleteObjectCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
      deleteInputs.push(input)
    }
  }
  class HeadObjectCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }
  class S3Client {
    send = sendMock
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand }
})

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn().mockResolvedValue(null),
}))

vi.mock("@/lib/implicit-feedback", () => ({
  createImplicitFeedback: vi.fn().mockReturnValue(null),
}))

vi.mock("@/lib/db", () => ({
  db: {
    material: { findUnique: vi.fn(), update: vi.fn() },
    aIFeedback: { upsert: vi.fn() },
  },
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { deleteTelegramMedia, isR2Url, isStorageUrl } from "@/lib/blob-storage"
import { DELETE } from "@/app/api/posts/[id]/route"

const USER_A = "user-a"
const USER_B = "user-b"
const MATERIAL_ID = "material-1"
const R2_HOST = "https://media.example.test"

const r2Url = (key: string) => `${R2_HOST}/${key}`

function setupAuth(userId: string, role: "USER" | "ADMIN" = "USER") {
  vi.mocked(requireAuth).mockResolvedValue({ userId, role })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function deleteMaterial(id = MATERIAL_ID) {
  return DELETE(
    new NextRequest(`http://localhost/api/posts/${id}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  deleteInputs.length = 0
  // A complete R2 config, so the vulnerable path really reaches the SDK and
  // the RED run fails on the delete it sends rather than on a missing env var.
  process.env.R2_ENDPOINT = "https://account.r2.cloudflarestorage.com"
  process.env.R2_ACCESS_KEY_ID = "test-key"
  process.env.R2_SECRET_ACCESS_KEY = "test-secret"
  process.env.R2_BUCKET_NAME = "radaric-media"
  process.env.R2_PUBLIC_URL = R2_HOST
  vi.mocked(db.material.update).mockResolvedValue({} as never)
})

afterEach(() => {
  delete process.env.R2_ENDPOINT
  delete process.env.R2_ACCESS_KEY_ID
  delete process.env.R2_SECRET_ACCESS_KEY
  delete process.env.R2_BUCKET_NAME
  delete process.env.R2_PUBLIC_URL
})

// ---------------------------------------------------------------------------
// AC-1 / AC-2 — the DELETE handler never sends an R2 delete
// ---------------------------------------------------------------------------

describe("DELETE /api/posts/[id] — per-user delete never touches R2", () => {
  it("AC-1: an owned material with R2 media is removed from the inbox and no R2 delete is sent", async () => {
    setupAuth(USER_A)
    vi.mocked(db.material.findUnique).mockResolvedValue({
      sourceId: "source-1",
      mediaUrls: [r2Url("telegram/design_digest/101.jpg")],
      thumbnailUrl: r2Url("telegram/design_digest/101_thumb.jpg"),
      feed: { userId: USER_A },
    } as never)

    const res = await deleteMaterial()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(db.material.update).toHaveBeenCalledWith({
      where: { id: MATERIAL_ID },
      data: { userStatus: "DELETED" },
    })
    expect(deleteInputs).toHaveLength(0)
  })

  it("AC-2: two users on the same telegram key — deleting either user's material leaves the object", async () => {
    const sharedKey = "telegram/design_digest/777.jpg"

    // Both rows reference the same deduped object; each user deletes their own copy.
    for (const [userId, materialId] of [
      [USER_A, "material-a"],
      [USER_B, "material-b"],
    ] as const) {
      setupAuth(userId)
      vi.mocked(db.material.findUnique).mockResolvedValue({
        sourceId: `source-${userId}`,
        mediaUrls: [r2Url(sharedKey)],
        thumbnailUrl: null,
        feed: { userId },
      } as never)

      const res = await deleteMaterial(materialId)

      expect(res.status).toBe(200)
      expect(db.material.update).toHaveBeenLastCalledWith({
        where: { id: materialId },
        data: { userStatus: "DELETED" },
      })
      // After both deletes the object is still there for everyone else.
      expect(deleteInputs.filter((input) => input.Key === sharedKey)).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// AC-3 — managed-storage recognition is an exact-host match
// ---------------------------------------------------------------------------

describe("isR2Url / isStorageUrl — only our own bucket host is managed storage", () => {
  it("AC-3: rejects every foreign host when R2_PUBLIC_URL is a custom domain", () => {
    process.env.R2_PUBLIC_URL = R2_HOST

    expect(isR2Url("https://media.example.test/telegram/x/1.jpg")).toBe(true)
    expect(isStorageUrl("https://media.example.test/telegram/x/1.jpg")).toBe(true)

    // Any other r2.dev zone is someone else's bucket.
    expect(isR2Url("https://evil.r2.dev/telegram/x/1.jpg")).toBe(false)
    expect(isR2Url("https://pub-abc.r2.dev/telegram/x/1.jpg")).toBe(false)
    expect(isStorageUrl("https://evil.r2.dev/telegram/x/1.jpg")).toBe(false)

    // Prefix look-alikes are not our host.
    expect(isR2Url("https://media.example.test.evil.com/telegram/x/1.jpg")).toBe(false)
    expect(isStorageUrl("https://media.example.test.evil.com/telegram/x/1.jpg")).toBe(false)

    // Junk is not managed storage either.
    expect(isR2Url("not a url")).toBe(false)

    // Legacy Vercel host: an exact suffix on the parsed hostname, not a substring.
    expect(isStorageUrl("https://abc.vercel-storage.com/telegram/x/1.jpg")).toBe(true)
    expect(isStorageUrl("https://x.vercel-storage.com.evil.io/telegram/x/1.jpg")).toBe(false)
  })

  it("AC-3: accepts exactly the configured r2.dev zone and no other", () => {
    process.env.R2_PUBLIC_URL = "https://pub-abc.r2.dev"

    expect(isR2Url("https://pub-abc.r2.dev/telegram/x/1.jpg")).toBe(true)
    expect(isStorageUrl("https://pub-abc.r2.dev/telegram/x/1.jpg")).toBe(true)

    expect(isR2Url("https://pub-other.r2.dev/telegram/x/1.jpg")).toBe(false)
    expect(isStorageUrl("https://pub-other.r2.dev/telegram/x/1.jpg")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RAD-369 — the DELETE body's feedback strings feed the evaluation prompt
// ---------------------------------------------------------------------------

describe("DELETE /api/posts/[id] — feedback comments are capped", () => {
  function ownedMaterial() {
    setupAuth(USER_A)
    vi.mocked(db.material.findUnique).mockResolvedValue({
      sourceId: "source-1",
      mediaUrls: [],
      thumbnailUrl: null,
      feed: { userId: USER_A },
    } as never)
  }

  function deleteWithFeedback(feedback: unknown) {
    return DELETE(
      new NextRequest(`http://localhost/api/posts/${MATERIAL_ID}`, {
        method: "DELETE",
        body: JSON.stringify(feedback),
      }),
      { params: Promise.resolve({ id: MATERIAL_ID }) }
    )
  }

  it("rejects a 501-character comment with 400, deleting nothing and writing no feedback", async () => {
    ownedMaterial()

    const res = await deleteWithFeedback({ globalFeedback: "a".repeat(501) })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "globalFeedback is too long (max 500 characters)" })
    expect(db.material.update).not.toHaveBeenCalled()
    expect(db.aIFeedback.upsert).not.toHaveBeenCalled()
  })

  it("accepts a 500-character comment", async () => {
    ownedMaterial()
    vi.mocked(db.aIFeedback.upsert).mockResolvedValue({} as never)

    const res = await deleteWithFeedback({ globalFeedback: "a".repeat(500) })

    expect(res.status).toBe(200)
    expect(db.aIFeedback.upsert).toHaveBeenCalledTimes(1)
    expect(db.material.update).toHaveBeenCalledWith({
      where: { id: MATERIAL_ID },
      data: { userStatus: "DELETED" },
    })
  })

  it("rejects a non-string comment with 400 and writes nothing", async () => {
    ownedMaterial()

    const res = await deleteWithFeedback({ sourceFeedback: 42 })

    expect(res.status).toBe(400)
    expect(db.material.update).not.toHaveBeenCalled()
    expect(db.aIFeedback.upsert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC-4 — the remaining delete entry point refuses a foreign host
// ---------------------------------------------------------------------------

describe("deleteTelegramMedia — a URL from feed content is never treated as ours", () => {
  it("AC-4: sends no DeleteObjectCommand for a foreign *.r2.dev host", async () => {
    process.env.R2_PUBLIC_URL = R2_HOST

    await deleteTelegramMedia("https://evil.r2.dev/telegram/design_digest/42.jpg")

    expect(deleteInputs).toHaveLength(0)
  })

  it("AC-4: sends no DeleteObjectCommand for a Vercel host look-alike", async () => {
    process.env.R2_PUBLIC_URL = R2_HOST

    await deleteTelegramMedia("https://x.vercel-storage.com.evil.io/telegram/design_digest/42.jpg")

    expect(deleteInputs).toHaveLength(0)
  })

  it("AC-4: still deletes a key under our own host (the probe script's contract)", async () => {
    process.env.R2_PUBLIC_URL = R2_HOST

    await deleteTelegramMedia(r2Url("telegram/design_digest/42.jpg"))

    expect(deleteInputs).toHaveLength(1)
    expect(deleteInputs[0]).toMatchObject({ Key: "telegram/design_digest/42.jpg" })
  })
})
