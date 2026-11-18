/**
 * lib/admin-subscription-state — admin dashboard's paid-subscription view.
 *
 * Covers: the purpose-built predicate (granting window, strict period boundary,
 * CANCELED with a future period end, precedence), the badge model (copy +
 * variant, lapsed → null), the summary copy (billing-verbatim strings,
 * lapsed never claims access), and the referral-trial badge (RAD-419).
 */

import { describe, it, expect } from "vitest"
import { SubscriptionStatus } from "@prisma/client"
import {
  classifyAdminSubscription,
  isGrantingAdminSub,
  isStripeSubscriptionId,
  adminSubBadge,
  adminSubSummary,
  adminTrialBadge,
  type AdminSubscriptionView,
} from "@/lib/admin-subscription-state"

// Midday UTC — a date can never shift across the assert timezone (UTC-11..+11).
const NOW = new Date("2026-10-18T12:00:00Z")
const FUTURE = new Date("2026-11-12T12:00:00Z")
const PAST = new Date("2026-10-01T12:00:00Z")

function classify(overrides: Partial<Parameters<typeof classifyAdminSubscription>[0]> = {}) {
  return classifyAdminSubscription(
    {
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: FUTURE,
      cancelAtPeriodEnd: false,
      ...overrides,
    },
    NOW
  )
}

function view(overrides: Partial<AdminSubscriptionView> = {}): AdminSubscriptionView {
  return {
    state: "active",
    status: SubscriptionStatus.ACTIVE,
    tier: "pro",
    interval: "monthly",
    currentPeriodEnd: FUTURE.toISOString(),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    createdAt: "2026-06-03T10:00:00Z",
    stripeSubscriptionId: "sub_pro_1",
    ...overrides,
  }
}

describe("classifyAdminSubscription", () => {
  it("ACTIVE within the period → active", () => {
    expect(classify()).toBe("active")
  })

  it("TRIALING within the period → active", () => {
    expect(classify({ status: SubscriptionStatus.TRIALING })).toBe("active")
  })

  it("PAST_DUE within the period → past_due (Stripe retrying, access continues)", () => {
    expect(classify({ status: SubscriptionStatus.PAST_DUE })).toBe("past_due")
  })

  it("PAST_DUE also set to cancel → past_due wins (the actionable warning)", () => {
    expect(classify({ status: SubscriptionStatus.PAST_DUE, cancelAtPeriodEnd: true })).toBe(
      "past_due"
    )
  })

  it("ACTIVE set to cancel within the period → ending", () => {
    expect(classify({ cancelAtPeriodEnd: true })).toBe("ending")
  })

  it("a period that ended exactly at now → lapsed (strict boundary)", () => {
    expect(classify({ currentPeriodEnd: NOW })).toBe("lapsed")
  })

  it("ACTIVE with an elapsed period → lapsed", () => {
    expect(classify({ currentPeriodEnd: PAST })).toBe("lapsed")
  })

  it("CANCELED with a future period end → lapsed (mid-period immediate cancel)", () => {
    // Stripe leaves current_period_end untouched on an immediate cancel; the
    // status is the truth. Must never classify as active/ending.
    expect(classify({ status: SubscriptionStatus.CANCELED })).toBe("lapsed")
  })

  it.each([
    SubscriptionStatus.UNPAID,
    SubscriptionStatus.PAUSED,
    SubscriptionStatus.INCOMPLETE,
    SubscriptionStatus.INCOMPLETE_EXPIRED,
    SubscriptionStatus.UNKNOWN,
  ])("%s with a future period end → lapsed", (status) => {
    expect(classify({ status })).toBe("lapsed")
  })
})

describe("isGrantingAdminSub", () => {
  it("grants for active / ending / past_due, not for lapsed", () => {
    expect(isGrantingAdminSub("active")).toBe(true)
    expect(isGrantingAdminSub("ending")).toBe(true)
    expect(isGrantingAdminSub("past_due")).toBe(true)
    expect(isGrantingAdminSub("lapsed")).toBe(false)
  })
})

describe("isStripeSubscriptionId", () => {
  it("accepts real Stripe ids and rejects the scripts' legacy comp ids", () => {
    expect(isStripeSubscriptionId("sub_test_0001")).toBe(true)
    // A `comp_` id is never a Stripe id; the `sub_` prefix decides.
    expect(isStripeSubscriptionId("comp_radaric")).toBe(false)
    expect(isStripeSubscriptionId("comp_test_0001")).toBe(false)
  })
})

describe("adminSubBadge", () => {
  it("active Pro → tonal badge, renews tooltip", () => {
    expect(adminSubBadge(view())).toEqual({
      label: "Pro",
      variant: "default",
      tooltip: "Pro — renews November 12, 2026",
    })
  })

  it("active Lite → Lite", () => {
    expect(adminSubBadge(view({ tier: "lite" }))?.label).toBe("Lite")
  })

  it("unmapped price on a granting subscription → neutral Paid (not billing's 'Active')", () => {
    const badge = adminSubBadge(view({ tier: null, interval: null }))
    expect(badge).toEqual({
      label: "Paid",
      variant: "default",
      tooltip: "Paid — renews November 12, 2026",
    })
  })

  it("ending → 'not renewing' on the tonal badge, access-until tooltip", () => {
    expect(
      adminSubBadge(view({ state: "ending", cancelAtPeriodEnd: true }))
    ).toEqual({
      label: "Pro · not renewing",
      variant: "default",
      tooltip: "Pro — access until November 12, 2026 (cancels at period end)",
    })
  })

  it("past_due → warning variant", () => {
    expect(
      adminSubBadge(view({ state: "past_due", status: SubscriptionStatus.PAST_DUE }))
    ).toEqual({
      label: "Pro · past due",
      variant: "warning",
      tooltip: "Pro — payment failed, retrying; access until November 12, 2026",
    })
  })

  it("lapsed → null (the row shows no badge)", () => {
    expect(
      adminSubBadge(view({ state: "lapsed", status: SubscriptionStatus.CANCELED }))
    ).toBeNull()
  })

  it("legacy comp row → muted grant badge, never a plan badge while granting", () => {
    const badge = adminSubBadge(
      view({ stripeSubscriptionId: "comp_radaric", tier: null, interval: null })
    )
    expect(badge).toEqual({
      label: "Legacy comp",
      variant: "outline",
      tooltip: "Legacy comp row — grants access, not a paid subscription",
    })
  })

  it("legacy comp badge ignores non-lapsed timing states (past_due on a comp row is meaningless)", () => {
    expect(
      adminSubBadge(
        view({
          stripeSubscriptionId: "comp_gift",
          state: "past_due",
          status: SubscriptionStatus.PAST_DUE,
        })
      )?.label
    ).toBe("Legacy comp")
  })

  // RAD-413: a hand-seeded comp row with a near end date lapses like any
  // other row — its badge must not keep saying it grants access.
  it("lapsed legacy comp row → null, no access claim", () => {
    expect(
      adminSubBadge(
        view({
          stripeSubscriptionId: "comp_gift",
          tier: null,
          interval: null,
          state: "lapsed",
          currentPeriodEnd: PAST.toISOString(),
        })
      )
    ).toBeNull()
  })
})

describe("adminSubSummary", () => {
  it("legacy comp row explains itself and never claims a plan or a renewal", () => {
    const summary = adminSubSummary(
      view({ stripeSubscriptionId: "comp_radaric", tier: null, interval: null })
    )
    expect(summary).toBe("Legacy comp row — no Stripe subscription · since June 3, 2026")
    expect(summary).not.toContain("Renews on")
  })

  it("lapsed legacy comp row reports its end, never 'grants' or 'since' (RAD-413)", () => {
    const summary = adminSubSummary(
      view({
        stripeSubscriptionId: "comp_gift",
        tier: null,
        interval: null,
        state: "lapsed",
        currentPeriodEnd: PAST.toISOString(),
      })
    )
    expect(summary).toBe("Legacy comp row — no Stripe subscription · ended October 1, 2026")
    expect(summary).not.toContain("grants")
    expect(summary).not.toContain("since")
  })

  it("lapsed legacy comp row canceled mid-period reports canceledAt, not the future period end", () => {
    const summary = adminSubSummary(
      view({
        stripeSubscriptionId: "comp_gift",
        tier: null,
        interval: null,
        state: "lapsed",
        status: SubscriptionStatus.CANCELED,
        canceledAt: "2026-10-10T12:00:00Z",
      })
    )
    expect(summary).toBe("Legacy comp row — no Stripe subscription · ended October 10, 2026")
  })

  it("lapsed legacy comp row canceled with no canceledAt falls back to the period end", () => {
    expect(
      adminSubSummary(
        view({
          stripeSubscriptionId: "comp_gift",
          tier: null,
          interval: null,
          state: "lapsed",
          status: SubscriptionStatus.CANCELED,
          canceledAt: null,
        })
      )
    ).toBe("Legacy comp row — no Stripe subscription · ended November 12, 2026")
  })

  it("elapsed ACTIVE comp row reports its period end even with a leftover canceledAt", () => {
    expect(
      adminSubSummary(
        view({
          stripeSubscriptionId: "comp_gift",
          tier: null,
          interval: null,
          state: "lapsed",
          currentPeriodEnd: PAST.toISOString(),
          canceledAt: "2026-09-20T12:00:00Z",
        })
      )
    ).toBe("Legacy comp row — no Stripe subscription · ended October 1, 2026")
  })

  it.each([
    SubscriptionStatus.PAUSED,
    SubscriptionStatus.UNPAID,
    SubscriptionStatus.INCOMPLETE,
    SubscriptionStatus.UNKNOWN,
  ])("%s comp row with a future period end claims no date", (status) => {
    const summary = adminSubSummary(
      view({ stripeSubscriptionId: "comp_gift", tier: null, interval: null, state: "lapsed", status })
    )
    expect(summary).toBe("Legacy comp row — no Stripe subscription · no longer grants access")
    expect(summary).not.toContain("November")
  })

  it("active reuses billing's 'Renews on' wording", () => {
    expect(adminSubSummary(view())).toBe(
      "Radaric Pro — Monthly · Renews on November 12, 2026 · since June 3, 2026"
    )
  })

  it("ending reuses billing's 'Access until … (cancels at period end)' wording", () => {
    expect(adminSubSummary(view({ state: "ending", cancelAtPeriodEnd: true }))).toBe(
      "Radaric Pro — Monthly · Access until November 12, 2026 (cancels at period end) · since June 3, 2026"
    )
  })

  it("past_due reuses billing's 'Payment failed — retrying' wording", () => {
    expect(
      adminSubSummary(view({ state: "past_due", status: SubscriptionStatus.PAST_DUE }))
    ).toBe(
      "Radaric Pro — Monthly · Payment failed — retrying. Access until November 12, 2026 · since June 3, 2026"
    )
  })

  it("yearly interval is named; unmapped interval is omitted, never 'null'", () => {
    expect(adminSubSummary(view({ interval: "yearly" }))).toContain("Radaric Pro — Yearly ·")
    const unmapped = adminSubSummary(view({ tier: null, interval: null }))
    expect(unmapped).toBe(
      "Radaric — unknown plan · Renews on November 12, 2026 · since June 3, 2026"
    )
    expect(unmapped).not.toContain("null")
  })

  it("CANCELED reports canceledAt and never claims access (future period end)", () => {
    const summary = adminSubSummary(
      view({
        state: "lapsed",
        status: SubscriptionStatus.CANCELED,
        canceledAt: "2026-10-03T10:00:00Z",
      })
    )
    expect(summary).toBe("Radaric Pro — Monthly · Canceled October 3, 2026")
    expect(summary).not.toContain("Access until")
  })

  it("CANCELED without canceledAt falls back to the period end", () => {
    expect(
      adminSubSummary(
        view({ state: "lapsed", status: SubscriptionStatus.CANCELED, canceledAt: null })
      )
    ).toBe("Radaric Pro — Monthly · Canceled November 12, 2026")
  })

  it("lapsed statuses each get their own copy", () => {
    expect(
      adminSubSummary(view({ state: "lapsed", status: SubscriptionStatus.UNPAID }))
    ).toBe("Radaric Pro — Monthly · Unpaid — access revoked")
    // UNPAID must not claim an "ended" date at all — the stored period end can
    // still be in the future when retries are exhausted.
    expect(
      adminSubSummary(
        view({
          state: "lapsed",
          status: SubscriptionStatus.UNPAID,
          currentPeriodEnd: FUTURE.toISOString(),
        })
      )
    ).not.toContain("access ended")
    expect(adminSubSummary(view({ state: "lapsed", status: SubscriptionStatus.PAUSED }))).toBe(
      "Radaric Pro — Monthly · Paused"
    )
    expect(
      adminSubSummary(view({ state: "lapsed", status: SubscriptionStatus.INCOMPLETE }))
    ).toBe("Radaric Pro — Monthly · Checkout incomplete")
    expect(
      adminSubSummary(view({ state: "lapsed", status: SubscriptionStatus.INCOMPLETE_EXPIRED }))
    ).toBe("Radaric Pro — Monthly · Checkout incomplete")
    expect(adminSubSummary(view({ state: "lapsed", status: SubscriptionStatus.UNKNOWN }))).toBe(
      "Radaric Pro — Monthly · Unknown status"
    )
    // Granting statuses whose period has simply elapsed read as an ended access.
    expect(
      adminSubSummary(
        view({ state: "lapsed", status: SubscriptionStatus.ACTIVE, currentPeriodEnd: PAST.toISOString() })
      )
    ).toBe("Radaric Pro — Monthly · Access ended October 1, 2026")
  })
})

describe("adminTrialBadge (RAD-419)", () => {
  const ENDS = "2026-10-25T12:00:00.000Z"

  it("a running referral trial → 'Trial · ends' with the date, Lite/no-card tooltip", () => {
    expect(adminTrialBadge({ complimentaryAccessUntil: ENDS, launchTrial: true }, NOW.getTime())).toEqual({
      label: "Trial · ends Oct 25",
      variant: "info",
      tooltip: "Referral trial (Lite, no card) — ends October 25, 2026",
    })
  })

  it("an ended referral trial → muted 'Trial ended'", () => {
    expect(
      adminTrialBadge({ complimentaryAccessUntil: PAST.toISOString(), launchTrial: true }, NOW.getTime())
    ).toEqual({
      label: "Trial ended",
      variant: "outline",
      tooltip: "Referral trial ended October 1, 2026",
    })
  })

  it("ends exactly now → ended (strict, like the comp gate)", () => {
    expect(
      adminTrialBadge({ complimentaryAccessUntil: NOW.toISOString(), launchTrial: true }, NOW.getTime())?.label
    ).toBe("Trial ended")
  })

  it("a manual comp or no comp → null (the row keeps its Comp badge)", () => {
    expect(adminTrialBadge({ complimentaryAccessUntil: ENDS, launchTrial: false }, NOW.getTime())).toBeNull()
    expect(adminTrialBadge({ complimentaryAccessUntil: null, launchTrial: true }, NOW.getTime())).toBeNull()
  })
})
