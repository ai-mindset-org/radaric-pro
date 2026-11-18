import { NextResponse } from "next/server"
import type { SubscriptionStatus } from "@prisma/client"
import { db } from "@/lib/db"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"
import { planFromPriceId } from "@/lib/entitlements"
import { isLaunchTrialComp } from "@/lib/trial-ref"
import {
  classifyAdminSubscription,
  isGrantingAdminSub,
  isStripeSubscriptionId,
  type AdminSubscriptionView,
} from "@/lib/admin-subscription-state"

export const dynamic = "force-dynamic"

type SubscriptionRow = {
  status: SubscriptionStatus
  stripePriceId: string
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  canceledAt: Date | null
  createdAt: Date
  stripeSubscriptionId: string
}

// Payload view for one user's subscription row. `now` is passed in — one clock
// read per response, so badges and the Subscribers count agree at boundaries.
// Tier/interval are derived here (server-side): the client cannot import
// lib/stripe.
function toSubscriptionView(sub: SubscriptionRow, now: Date): AdminSubscriptionView {
  const plan = planFromPriceId(sub.stripePriceId)
  return {
    state: classifyAdminSubscription(
      {
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      },
      now
    ),
    status: sub.status,
    tier: plan?.tier ?? null,
    interval: plan?.interval ?? null,
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt?.toISOString() ?? null,
    createdAt: sub.createdAt.toISOString(),
    stripeSubscriptionId: sub.stripeSubscriptionId,
  }
}

export async function GET() {
  const auth = await requireAdmin()
  if (isErrorResponse(auth)) return auth

  try {
    const [users, feeds, materialCounts, feedbackCounts] = await Promise.all([
      db.user.findMany({
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          complimentaryAccessUntil: true,
          createdAt: true,
          updatedAt: true,
          // 1:1 relation — nested select keeps this one query (no join map).
          subscription: {
            select: {
              status: true,
              stripePriceId: true,
              currentPeriodEnd: true,
              cancelAtPeriodEnd: true,
              canceledAt: true,
              createdAt: true,
              stripeSubscriptionId: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.feed.findMany({
        select: {
          id: true,
          userId: true,
          type: true,
          status: true,
          lastParsedAt: true,
        },
      }),
      db.material.groupBy({
        by: ["sourceId"],
        _count: { id: true },
      }),
      db.aIFeedback.groupBy({
        by: ["userId"],
        _count: { id: true },
      }),
    ])

    // Build feed-to-material count map
    const feedMaterialMap = new Map<string, number>()
    for (const m of materialCounts) {
      if (m.sourceId) feedMaterialMap.set(m.sourceId, m._count.id)
    }

    // Build user feedback count map
    const feedbackMap = new Map<string, number>()
    for (const f of feedbackCounts) {
      if (f.userId) feedbackMap.set(f.userId, f._count.id)
    }

    // Build per-user feed stats
    const userFeedMap = new Map<string, {
      rss: number; telegram: number; twitter: number; youtube: number; interest: number; total: number
      active: number; error: number; materials: number; lastParsedAt: string | null
    }>()

    for (const feed of feeds) {
      if (!feed.userId) continue
      let entry = userFeedMap.get(feed.userId)
      if (!entry) {
        entry = { rss: 0, telegram: 0, twitter: 0, youtube: 0, interest: 0, total: 0, active: 0, error: 0, materials: 0, lastParsedAt: null }
        userFeedMap.set(feed.userId, entry)
      }
      entry.total++
      if (feed.type === "RSS") entry.rss++
      else if (feed.type === "TELEGRAM") entry.telegram++
      else if (feed.type === "TWITTER") entry.twitter++
      else if (feed.type === "YOUTUBE") entry.youtube++
      else if (feed.type === "INTEREST" || feed.type === "EVENT_TRIGGER") entry.interest++
      if (feed.status === "ACTIVE") entry.active++
      if (feed.status === "ERROR") entry.error++
      entry.materials += feedMaterialMap.get(feed.id) || 0
      if (feed.lastParsedAt) {
        const ts = feed.lastParsedAt.toISOString()
        if (!entry.lastParsedAt || ts > entry.lastParsedAt) entry.lastParsedAt = ts
      }
    }

    // Assemble user rows
    const now = new Date()
    const userRows = users.map(u => {
      const feedStats = userFeedMap.get(u.id) || { rss: 0, telegram: 0, twitter: 0, youtube: 0, interest: 0, total: 0, active: 0, error: 0, materials: 0, lastParsedAt: null }
      return {
        id: u.id,
        username: u.username,
        name: u.name,
        email: u.email,
        role: u.role,
        isActive: u.isActive,
        complimentaryAccessUntil: u.complimentaryAccessUntil?.toISOString() ?? null,
        // RAD-419: the comp is the referral sign-up trial, not a hand grant.
        launchTrial: isLaunchTrialComp(u),
        subscription: u.subscription ? toSubscriptionView(u.subscription, now) : null,
        createdAt: u.createdAt.toISOString(),
        feeds: {
          rss: feedStats.rss,
          telegram: feedStats.telegram,
          twitter: feedStats.twitter,
          youtube: feedStats.youtube,
          interest: feedStats.interest,
          total: feedStats.total,
          active: feedStats.active,
          error: feedStats.error,
        },
        materials: feedStats.materials,
        feedbackCount: feedbackMap.get(u.id) || 0,
        lastParsedAt: feedStats.lastParsedAt,
      }
    })

    // Totals
    const totals = {
      users: users.length,
      feeds: feeds.length,
      materials: materialCounts.reduce((sum, m) => sum + m._count.id, 0),
      feedback: feedbackCounts.reduce((sum, f) => sum + f._count.id, 0),
      // Same predicate as the row badges — the card can never disagree with
      // them. Real `sub_` ids only: the scripts' legacy `comp_…` rows grant
      // access but were never payments.
      subscribers: userRows.filter(
        u =>
          u.subscription &&
          isGrantingAdminSub(u.subscription.state) &&
          isStripeSubscriptionId(u.subscription.stripeSubscriptionId)
      ).length,
      // Launch-trial accounts, running and ended. A trial is a comp, never a
      // payment: it stays out of `subscribers` unless the account also pays.
      referralTrials: userRows.filter(u => u.launchTrial).length,
      referralTrialsActive: userRows.filter(
        u => u.launchTrial && new Date(u.complimentaryAccessUntil!).getTime() > now.getTime()
      ).length,
    }

    return NextResponse.json({ users: userRows, totals })
  } catch (error) {
    console.error("[ADMIN DASHBOARD ERROR]:", error)
    return NextResponse.json({ error: "Failed to fetch admin data" }, { status: 500 })
  }
}
