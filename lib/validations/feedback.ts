import { z } from "zod"

/**
 * Cap for any feedback comment that reaches the evaluation prompt
 * (`lib/ai.ts` renders up to 150 of them into every filter call).
 */
export const FEEDBACK_COMMENT_MAX = 500

export const feedbackSchema = z.object({
  feedbackType: z.enum(["LIKE", "DISLIKE"]),
  comment: z.string().trim().max(FEEDBACK_COMMENT_MAX).optional(),
})

export type FeedbackFormData = z.infer<typeof feedbackSchema>

export const updateFeedbackSchema = z
  .object({
    feedbackType: z.enum(["LIKE", "DISLIKE"]).optional(),
    comment: z.string().trim().max(FEEDBACK_COMMENT_MAX).optional(),
  })
  .refine(
    (data) => data.feedbackType !== undefined || data.comment !== undefined,
    { message: "At least one field required" }
  )

export type UpdateFeedbackFormData = z.infer<typeof updateFeedbackSchema>
