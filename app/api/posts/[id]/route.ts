import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { createImplicitFeedback } from "@/lib/implicit-feedback"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { isEmailVerified } from "@/lib/email-verification"
import { FEEDBACK_COMMENT_MAX } from "@/lib/validations/feedback"

/**
 * RAD-369 — the DELETE body's two feedback strings are stored as
 * `AIFeedback.commentText`, and up to 150 of those texts are rendered into every
 * evaluation prompt (`lib/ai.ts`). Uncapped and untyped here, they were a bypass
 * of the 8000-character `globalPrompt` cap: the same text moved into a comment
 * reached the prompt at full length. Same 500-character bound as
 * `lib/validations/feedback.ts`; an empty body stays valid.
 */
const deleteBodySchema = z.object({
  sourceFeedback: z
    .string()
    .trim()
    .max(FEEDBACK_COMMENT_MAX, {
      message: `sourceFeedback is too long (max ${FEEDBACK_COMMENT_MAX} characters)`,
    })
    .optional(),
  globalFeedback: z
    .string()
    .trim()
    .max(FEEDBACK_COMMENT_MAX, {
      message: `globalFeedback is too long (max ${FEEDBACK_COMMENT_MAX} characters)`,
    })
    .optional(),
})

// GET /api/materials/[id] - Get a single material (only if owned by user)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const { id } = await params
    const material = await db.material.findUnique({
      where: { id },
      include: {
        feed: true,
      },
    })

    if (!material) {
      return NextResponse.json(
        { error: "Material not found" },
        { status: 404 }
      )
    }

    // Check ownership through source
    if (material.feed.userId !== userId) {
      return NextResponse.json(
        { error: "Material not found" },
        { status: 404 }
      )
    }

    return NextResponse.json(material)
  } catch (error) {
    console.error("Error fetching material:", error)
    return NextResponse.json(
      { error: "Failed to fetch material" },
      { status: 500 }
    )
  }
}

// PATCH /api/materials/[id] - Update a material (only if owned by user)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { id } = await params
    const body = await request.json()

    // Check ownership through source
    const existingMaterial = await db.material.findUnique({
      where: { id },
      include: { feed: true },
    })

    if (!existingMaterial || existingMaterial.feed.userId !== userId) {
      return NextResponse.json(
        { error: "Material not found" },
        { status: 404 }
      )
    }

    // Validate input
    const allowedFields = ["title", "content", "userStatus"]
    const providedFields = Object.keys(body)
    const invalidFields = providedFields.filter(field => !allowedFields.includes(field))

    if (invalidFields.length > 0) {
      return NextResponse.json(
        { error: `Invalid fields: ${invalidFields.join(", ")}` },
        { status: 400 }
      )
    }

    // Validate userStatus if provided
    const validStatuses = ["NEW", "READ", "SENT_TO_NOTION", "DELETED", "ARCHIVED", "SENT_TO_STORIES"]
    if (body.userStatus && !validStatuses.includes(body.userStatus)) {
      return NextResponse.json(
        { error: `Invalid userStatus. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      )
    }

    // Build update data object with only provided fields
    const updateData: Record<string, unknown> = {}
    if (body.title !== undefined) updateData.title = body.title
    if (body.content !== undefined) updateData.content = body.content
    if (body.userStatus !== undefined) updateData.userStatus = body.userStatus

    const material = await db.material.update({
      where: { id },
      data: updateData,
    })

    // Trigger story matching when user manually approves a FILTERED material
    // by moving it to an approval status (SENT_TO_NOTION, SENT_TO_STORIES)
    if (
      body.userStatus &&
      existingMaterial.aiEvaluation === "FILTERED" &&
      ["SENT_TO_NOTION", "SENT_TO_STORIES"].includes(body.userStatus) &&
      !existingMaterial.storyId
    ) {
      // RAD-296/297: this manual-approval path triggers PAID story matching —
      // bound it per user AND require a verified email. When skipped, the
      // material is STILL flipped to APPROVED so a later sweep can group it.
      const storyMatchLimited = checkUserRateLimit("post-story-match", userId, role, RATE_LIMITS.postStoryMatch)
      const skipStoryMatch = storyMatchLimited !== null || !(await isEmailVerified(userId, role))
      if (skipStoryMatch) {
        console.warn("[PATCH] story matching skipped (rate-limited or unverified email) — material stays eligible")
      }
      // Update aiEvaluation to APPROVED so the pipeline accepts this material,
      // then trigger story matching (fire-and-forget).
      db.material.update({
        where: { id },
        data: { aiEvaluation: "APPROVED" },
      })
        .then(async () => {
          if (skipStoryMatch) return
          const { buildMaterialStoryDeps } = await import("@/lib/story-aggregator/pipeline-deps")
          const { processApprovedMaterials } = await import("@/lib/story-aggregator/material-story-pipeline")
          const deps = await buildMaterialStoryDeps(userId)
          // Explicit user intent ("send to stories") may form a single-material story —
          // unlike the automatic Group Stories sweep, which only clusters 2+ posts.
          return processApprovedMaterials([id], userId, deps, { allowSingletonStory: true })
        })
        .catch((err: unknown) => {
          console.error("[PATCH] Story matching failed for manually approved material:", err)
        })
    }

    // Create implicit feedback when user overrides AI decision
    if (body.userStatus) {
      try {
        const existingFeedback = await db.aIFeedback.findFirst({
          where: { userId, materialId: id },
        })

        const implicitFeedback = createImplicitFeedback({
          materialId: id,
          sourceId: existingMaterial.sourceId,
          userId,
          aiEvaluation: existingMaterial.aiEvaluation,
          aiConfidence: existingMaterial.aiConfidence,
          aiReasoning: existingMaterial.aiReasoning,
          newStatus: body.userStatus,
          hasExplicitFeedback: !!existingFeedback,
        })

        if (implicitFeedback) {
          await db.aIFeedback.upsert({
            where: {
              userId_materialId: {
                userId: implicitFeedback.userId,
                materialId: implicitFeedback.materialId,
              },
            },
            update: {
              feedbackType: implicitFeedback.feedbackType,
              commentText: implicitFeedback.commentText,
              feedbackSource: "implicit",
            },
            create: {
              userId: implicitFeedback.userId,
              materialId: implicitFeedback.materialId,
              sourceId: implicitFeedback.sourceId,
              feedbackType: implicitFeedback.feedbackType,
              commentText: implicitFeedback.commentText,
              feedbackSource: "implicit",
              isGlobal: implicitFeedback.isGlobal,
            },
          })
          console.log(
            `[Implicit Feedback] ${implicitFeedback.feedbackType} for material ${id} (${existingMaterial.aiEvaluation} → ${body.userStatus})`
          )
        }
      } catch (feedbackError) {
        // Don't fail the status update if implicit feedback creation fails
        console.error("Error creating implicit feedback:", feedbackError)
      }
    }

    return NextResponse.json(material)
  } catch (error) {
    console.error("Error updating material:", error)
    return NextResponse.json(
      { error: "Failed to update material" },
      { status: 500 }
    )
  }
}

// DELETE /api/materials/[id] - Delete a material with optional feedback (only if owned by user)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const { id } = await params
    const rawBody = await request.json().catch(() => ({}))
    const parsedBody = deleteBodySchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: parsedBody.error.issues[0]?.message ?? "Invalid feedback" },
        { status: 400 }
      )
    }
    const { sourceFeedback, globalFeedback } = parsedBody.data

    // Get material before deleting to get sourceId
    const material = await db.material.findUnique({
      where: { id },
      select: {
        sourceId: true,
        feed: {
          select: { userId: true },
        },
      },
    })

    if (!material) {
      return NextResponse.json(
        { error: "Material not found" },
        { status: 404 }
      )
    }

    // Check ownership through source
    if (material.feed.userId !== userId) {
      return NextResponse.json(
        { error: "Material not found" },
        { status: 404 }
      )
    }

    // RAD-368: a per-user material delete NEVER removes R2 objects. The only
    // objects we write are Telegram media under `telegram/<channel>/<id>.*`,
    // deduped by key, so one object is shared by every user subscribed to that
    // channel — deleting "this user's copy" would break everyone else's, and a
    // media URL taken from feed content must never name a key of ours. Unrefed
    // objects are left for a future GC sweep.

    // Create feedback entry if provided (single upsert — unique constraint on userId+materialId)
    if (sourceFeedback && globalFeedback) {
      await db.aIFeedback.upsert({
        where: { userId_materialId: { userId, materialId: id } },
        update: {
          commentText: globalFeedback,
          feedbackType: "DISLIKE",
          feedbackSource: "explicit",
          isGlobal: true,
        },
        create: {
          userId,
          materialId: id,
          sourceId: material.sourceId,
          commentText: globalFeedback,
          feedbackType: "DISLIKE",
          feedbackSource: "explicit",
          isGlobal: true,
        },
      })
    } else if (sourceFeedback) {
      await db.aIFeedback.upsert({
        where: { userId_materialId: { userId, materialId: id } },
        update: {
          commentText: sourceFeedback,
          feedbackType: "DISLIKE",
          feedbackSource: "explicit",
        },
        create: {
          userId,
          materialId: id,
          sourceId: material.sourceId,
          commentText: sourceFeedback,
          feedbackType: "DISLIKE",
          feedbackSource: "explicit",
          isGlobal: false,
        },
      })
    } else if (globalFeedback) {
      await db.aIFeedback.upsert({
        where: { userId_materialId: { userId, materialId: id } },
        update: {
          commentText: globalFeedback,
          feedbackType: "DISLIKE",
          feedbackSource: "explicit",
          isGlobal: true,
        },
        create: {
          userId,
          materialId: id,
          commentText: globalFeedback,
          feedbackType: "DISLIKE",
          feedbackSource: "explicit",
          isGlobal: true,
        },
      })
    }

    await db.material.update({
      where: { id },
      data: {
        userStatus: "DELETED",
      },
    })

    return NextResponse.json({
      success: true,
      message: "Material deleted and feedback saved"
    })
  } catch (error) {
    console.error("Error deleting material:", error)
    return NextResponse.json(
      { error: "Failed to delete material" },
      { status: 500 }
    )
  }
}
