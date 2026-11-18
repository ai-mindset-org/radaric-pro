export interface ImplicitFeedbackParams {
  materialId: string
  sourceId: string
  userId: string
  aiEvaluation: "FILTERED" | "APPROVED"
  aiConfidence: number
  aiReasoning: string | null
  newStatus: string
  hasExplicitFeedback: boolean
}

export interface ImplicitFeedbackResult {
  feedbackType: "LIKE" | "DISLIKE"
  commentText: string
  materialId: string
  sourceId: string
  userId: string
  isGlobal: false
  feedbackSource: "implicit"
}

export function createImplicitFeedback(
  params: ImplicitFeedbackParams
): ImplicitFeedbackResult | null {
  const { materialId, sourceId, userId, aiEvaluation, aiConfidence, aiReasoning, newStatus, hasExplicitFeedback } = params

  if (hasExplicitFeedback) return null

  const approvalStatuses = new Set(["SENT_TO_NOTION", "SENT_TO_STORIES"])
  const rejectionStatuses = new Set(["DELETED"])

  let feedbackType: "LIKE" | "DISLIKE"
  let baseComment: string

  if (aiEvaluation === "FILTERED" && approvalStatuses.has(newStatus)) {
    feedbackType = "LIKE"
    baseComment = `User approved AI-filtered material (confidence: ${aiConfidence}%)`
  } else if (aiEvaluation === "APPROVED" && rejectionStatuses.has(newStatus)) {
    feedbackType = "DISLIKE"
    baseComment = `User deleted AI-approved material (confidence: ${aiConfidence}%)`
  } else {
    return null
  }

  const commentText = aiReasoning != null
    ? `${baseComment}. AI reasoning: ${aiReasoning}`
    : baseComment

  return {
    feedbackType,
    commentText,
    materialId,
    sourceId,
    userId,
    isGlobal: false,
    feedbackSource: "implicit",
  }
}
