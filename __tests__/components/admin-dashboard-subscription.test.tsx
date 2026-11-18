/**
 * @vitest-environment jsdom
 */

/**
 * AdminDashboard — paid-subscription visibility (RAD-412).
 * The row badge appears only for access-granting subscriptions, the Subscribers
 * card counts them, and the expanded row shows the billing-verbatim summary
 * plus the Stripe subscription id. Lapsed rows carry no badge and their detail
 * line never claims access. Launch-trial comps (RAD-419) get their own badge
 * and their own "Referral trials" card, never the Subscribers one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, fireEvent } from "@testing-library/react"

import { AdminDashboard } from "@/components/admin/admin-dashboard"

const EMPTY_FEEDS = { rss: 0, telegram: 0, twitter: 0, youtube: 0, interest: 0, total: 0, active: 0, error: 0 }

const DASHBOARD_DATA = {
  users: [
    {
      id: "u1",
      username: "alice",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: null,
      subscription: {
        state: "active",
        status: "ACTIVE",
        tier: "pro",
        interval: "monthly",
        currentPeriodEnd: "2099-01-01T12:00:00.000Z",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        createdAt: "2026-02-01T12:00:00.000Z",
        stripeSubscriptionId: "sub_pro_1",
      },
      createdAt: "2026-01-01T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
    {
      id: "u2",
      username: "bob",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: null,
      subscription: {
        state: "lapsed",
        status: "CANCELED",
        tier: "lite",
        interval: "monthly",
        currentPeriodEnd: "2026-05-01T12:00:00.000Z",
        cancelAtPeriodEnd: false,
        canceledAt: "2026-04-02T12:00:00.000Z",
        createdAt: "2026-02-01T12:00:00.000Z",
        stripeSubscriptionId: "sub_canceled_2",
      },
      createdAt: "2026-01-02T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
    {
      id: "u3",
      username: "carol",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: null,
      subscription: null,
      createdAt: "2026-01-03T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
    {
      id: "u4",
      username: "dave",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: null,
      subscription: {
        state: "past_due",
        status: "PAST_DUE",
        tier: "pro",
        interval: "monthly",
        currentPeriodEnd: "2026-12-12T12:00:00.000Z",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        createdAt: "2026-02-01T12:00:00.000Z",
        stripeSubscriptionId: "sub_past_due_3",
      },
      createdAt: "2026-01-04T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
    {
      id: "u5",
      username: "erin",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: null,
      subscription: {
        state: "active",
        status: "ACTIVE",
        tier: null,
        interval: null,
        currentPeriodEnd: "2077-12-31T23:59:59.000Z",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        createdAt: "2026-05-19T12:00:00.000Z",
        stripeSubscriptionId: "comp_cmnx73gwe0024qh0q27mqp77b",
      },
      createdAt: "2026-01-05T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
    {
      id: "u6",
      username: "fay",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: "2099-01-08T12:00:00.000Z",
      launchTrial: true,
      subscription: null,
      createdAt: "2099-01-01T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
    {
      id: "u7",
      username: "gus",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: "2026-09-08T12:00:00.000Z",
      launchTrial: true,
      subscription: null,
      createdAt: "2026-09-01T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
    {
      id: "u8",
      username: "hal",
      name: null,
      email: null,
      role: "USER",
      isActive: true,
      complimentaryAccessUntil: "2099-03-01T12:00:00.000Z",
      launchTrial: false,
      subscription: null,
      createdAt: "2026-01-08T12:00:00.000Z",
      feeds: EMPTY_FEEDS,
      materials: 0,
      feedbackCount: 0,
      lastParsedAt: null,
    },
  ],
  totals: { users: 8, feeds: 0, materials: 0, feedback: 0, subscribers: 2, referralTrials: 2, referralTrialsActive: 1 },
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => DASHBOARD_DATA }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AdminDashboard — paid subscriptions", () => {
  it("badges only the access-granting subscriptions and shows the Subscribers count", async () => {
    render(<AdminDashboard />)
    await screen.findByText("alice")

    expect(screen.getByText("Pro")).toBeInTheDocument()
    // dave (PAST_DUE) still grants — warning badge with its full tooltip as the
    // accessible name.
    expect(screen.getByText("Pro · past due")).toBeInTheDocument()
    expect(
      screen.getByLabelText("Pro — payment failed, retrying; access until December 12, 2026")
    ).toBeInTheDocument()
    // bob (CANCELED) and carol (no row) → no plan badge anywhere.
    expect(screen.queryByText(/Lite/)).not.toBeInTheDocument()
    expect(screen.queryByText(/not renewing/)).not.toBeInTheDocument()
    // erin's scripts' legacy comp row → muted grant badge, never "Paid"/green.
    expect(screen.getByText("Legacy comp")).toBeInTheDocument()
    expect(screen.queryByText("Paid")).not.toBeInTheDocument()
    // The Subscribers card binds totals.subscribers, not another total.
    expect(screen.getByText("Subscribers").closest("div")).toHaveTextContent("2")
  })

  it("expands an active subscriber into the plan summary and Stripe id", async () => {
    render(<AdminDashboard />)
    await screen.findByText("alice")

    fireEvent.click(screen.getAllByLabelText("Expand user details")[0])

    expect(
      await screen.findByText(/Radaric Pro — Monthly · Renews on January 1, 2099 · since February 1, 2026/)
    ).toBeInTheDocument()
    expect(screen.getByText("sub_pro_1")).toBeInTheDocument()
  })

  it("shows a lapsed subscription as canceled without claiming access", async () => {
    render(<AdminDashboard />)
    await screen.findByText("bob")

    fireEvent.click(screen.getAllByLabelText("Expand user details")[1])

    expect(await screen.findByText(/Radaric Lite — Monthly · Canceled April 2, 2026/)).toBeInTheDocument()
    expect(screen.getByText("sub_canceled_2")).toBeInTheDocument()
    expect(screen.queryByText(/Access until/)).not.toBeInTheDocument()
  })
})

describe("AdminDashboard — referral trials (RAD-419)", () => {
  it("labels referral trials apart from manual comps", async () => {
    render(<AdminDashboard />)
    await screen.findByText("fay")

    expect(screen.getByText("Trial · ends Jan 8")).toBeInTheDocument()
    expect(
      screen.getByLabelText("Referral trial (Lite, no card) — ends January 8, 2099")
    ).toBeInTheDocument()
    expect(screen.getByText("Trial ended")).toBeInTheDocument()
    // Only hal's manual comp keeps the Comp badge; gus's ended trial is not "Comp expired".
    expect(screen.getAllByText(/^Comp ·/)).toHaveLength(1)
    expect(screen.queryByText("Comp expired")).not.toBeInTheDocument()
  })

  it("counts referral trials (all, and running) on their own card, never as Subscribers", async () => {
    render(<AdminDashboard />)
    await screen.findByText("fay")

    const trials = screen.getByText("Referral trials").closest("div")
    expect(trials).toHaveTextContent("2")
    expect(trials).toHaveTextContent("1 active")
    expect(screen.getByText("Subscribers").closest("div")).toHaveTextContent("2")
  })
})
