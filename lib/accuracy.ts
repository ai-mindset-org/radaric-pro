export interface AccuracyMetrics {
  totalDecisions: number
  agreements: number
  overrides: number
  falsePositives: number
  falseNegatives: number
  agreementRate: number
  perSource: Record<string, Omit<AccuracyMetrics, "perSource">>
}

interface Material {
  aiEvaluation: string
  userStatus: string
  sourceId: string
}

const USER_USED = new Set(["SENT_TO_NOTION", "SENT_TO_STORIES"])
// ARCHIVED is excluded — it's ambiguous (normal workflow, not necessarily disagreement)
const USER_REJECTED_FILTERED = new Set(["ARCHIVED", "DELETED"]) // AI filtered + user archived/deleted = agreement
const USER_REJECTED_APPROVED = new Set(["DELETED"]) // AI approved + user DELETED = false positive (ARCHIVED excluded)

function computeSourceMetrics(
  materials: Material[]
): Omit<AccuracyMetrics, "perSource"> {
  let totalDecisions = 0
  let agreements = 0
  let overrides = 0
  let falsePositives = 0
  let falseNegatives = 0

  for (const m of materials) {
    if (m.userStatus === "NEW" || m.userStatus === "READ") continue
    if (m.aiEvaluation !== "APPROVED" && m.aiEvaluation !== "FILTERED") continue

    const aiApproved = m.aiEvaluation === "APPROVED"
    const userUsed = USER_USED.has(m.userStatus)

    if (aiApproved && m.userStatus === "ARCHIVED") {
      // Ambiguous — skip entirely. Archive of approved content is normal workflow.
      continue
    }

    totalDecisions++

    const userRejectedFiltered = USER_REJECTED_FILTERED.has(m.userStatus)
    const userRejectedApproved = USER_REJECTED_APPROVED.has(m.userStatus)

    if (aiApproved && userUsed) {
      agreements++
    } else if (!aiApproved && userRejectedFiltered) {
      agreements++
    } else if (aiApproved && userRejectedApproved) {
      overrides++
      falsePositives++
    } else if (!aiApproved && userUsed) {
      overrides++
      falseNegatives++
    }
  }

  const agreementRate =
    totalDecisions === 0
      ? 0
      : Math.round((agreements / totalDecisions) * 100)

  return {
    totalDecisions,
    agreements,
    overrides,
    falsePositives,
    falseNegatives,
    agreementRate,
  }
}

export function computeAccuracyMetrics(materials: Material[]): AccuracyMetrics {
  const overall = computeSourceMetrics(materials)

  const bySource = new Map<string, Material[]>()
  for (const m of materials) {
    const group = bySource.get(m.sourceId) ?? []
    group.push(m)
    bySource.set(m.sourceId, group)
  }

  const perSource: Record<string, Omit<AccuracyMetrics, "perSource">> = {}
  for (const [sourceId, group] of bySource) {
    const metrics = computeSourceMetrics(group)
    if (metrics.totalDecisions > 0) {
      perSource[sourceId] = metrics
    }
  }

  return { ...overall, perSource }
}
