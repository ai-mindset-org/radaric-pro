/**
 * @vitest-environment jsdom
 */

/**
 * BillingSection — two-tier (Lite/Pro) billing UI.
 *   - current-plan label reflects tier + interval
 *   - Lite users see the "Upgrade to Pro" card; Pro users do not
 *   - the subscribe view offers both Lite and Pro
 *   - a referral-trial comp (RAD-419) reads as a free trial; a manual comp keeps
 *     the courtesy copy word for word
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

import { BillingSection } from "@/components/settings/billing-section"

const FUTURE = new Date(Date.now() + 30 * 86400 * 1000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
})

describe("BillingSection", () => {
  it("labels an active Lite-monthly plan and offers the Pro upgrade", () => {
    render(
      <BillingSection
        contactEmail="kirill@radaric.pro"
        hasActiveAccess
        subscriptionActive
        nowMs={Date.now()}
        complimentaryAccessUntil={null}
        successState={false}
        canceledState={false}
        subscription={{
          status: "ACTIVE",
          tier: "lite",
          interval: "monthly",
          currentPeriodEnd: FUTURE,
          cancelAtPeriodEnd: false,
        }}
      />
    )

    expect(screen.getByText("Radaric Lite — Monthly")).toBeInTheDocument()
    expect(screen.getByText(/Upgrade to Pro/i)).toBeInTheDocument()
  })

  it("does not show the Pro upgrade card to a Pro user", () => {
    render(
      <BillingSection
        contactEmail="kirill@radaric.pro"
        hasActiveAccess
        subscriptionActive
        nowMs={Date.now()}
        complimentaryAccessUntil={null}
        successState={false}
        canceledState={false}
        subscription={{
          status: "ACTIVE",
          tier: "pro",
          interval: "monthly",
          currentPeriodEnd: FUTURE,
          cancelAtPeriodEnd: false,
        }}
      />
    )

    expect(screen.getByText("Radaric Pro — Monthly")).toBeInTheDocument()
    expect(screen.queryByText(/Upgrade to Pro/i)).not.toBeInTheDocument()
    // Pro-monthly still gets the yearly nudge.
    expect(screen.getByText(/Switch to yearly/i)).toBeInTheDocument()
  })

  it("offers both tiers in the subscribe view when there is no active plan", () => {
    render(
      <BillingSection
        contactEmail="kirill@radaric.pro"
        hasActiveAccess={false}
        subscriptionActive={false}
        nowMs={Date.now()}
        complimentaryAccessUntil={null}
        successState={false}
        canceledState={false}
        subscription={null}
      />
    )

    expect(screen.getByText("Choose your plan")).toBeInTheDocument()
    expect(screen.getByText("Radaric Lite")).toBeInTheDocument()
    expect(screen.getByText("Radaric Pro")).toBeInTheDocument()
  })

  it("shows the complimentary-access gift (not the raw paywall) for a comp user with no subscription", () => {
    render(
      <BillingSection
        contactEmail="kirill@radaric.pro"
        hasActiveAccess
        subscriptionActive={false}
        complimentaryAccessUntil={FUTURE}
        nowMs={Date.now()}
        successState={false}
        canceledState={false}
        subscription={null}
      />
    )

    // The gift is the focal element…
    expect(screen.getByText("Complimentary access")).toBeInTheDocument()
    expect(screen.getByText(/courtesy of the team/i)).toBeInTheDocument()
    expect(screen.getByText(/except Twitter\/X account parsing/i)).toBeInTheDocument()
    // …plans stay visible (no hidden options) under forward-looking framing.
    expect(screen.getByText("Keep your access going")).toBeInTheDocument()
    expect(screen.getByText("Radaric Lite")).toBeInTheDocument()
    expect(screen.queryByText("Choose your plan")).not.toBeInTheDocument()
  })

  it("shows the gift (not a stale 'Current plan') for a comp user whose subscription is canceled", () => {
    // Regression: isActive must key off subscriptionActive, not hasActiveAccess.
    // A comp grant + a dead sub row must NOT render the manage card.
    render(
      <BillingSection
        contactEmail="kirill@radaric.pro"
        hasActiveAccess
        subscriptionActive={false}
        complimentaryAccessUntil={FUTURE}
        nowMs={Date.now()}
        successState={false}
        canceledState={false}
        subscription={{
          status: "CANCELED",
          tier: "pro",
          interval: "monthly",
          currentPeriodEnd: new Date(Date.now() - 5 * 86400 * 1000).toISOString(),
          cancelAtPeriodEnd: false,
        }}
      />
    )

    expect(screen.getByText("Complimentary access")).toBeInTheDocument()
    expect(screen.getByText(/courtesy of the team/i)).toBeInTheDocument()
    // The stale manage card must NOT appear.
    expect(screen.queryByText("Current plan")).not.toBeInTheDocument()
    expect(screen.queryByText(/Manage billing/i)).not.toBeInTheDocument()
  })
})

// Midday UTC: the formatted dates cannot shift across the test timezone.
const NOW_MS = Date.parse("2026-10-22T12:00:00Z")
const DAY_MS = 86_400_000

function renderComp(daysLeft: number, launchTrial?: boolean) {
  render(
    <BillingSection
      contactEmail="kirill@radaric.pro"
      hasActiveAccess
      subscriptionActive={false}
      complimentaryAccessUntil={new Date(NOW_MS + daysLeft * DAY_MS).toISOString()}
      launchTrial={launchTrial}
      nowMs={NOW_MS}
      successState={false}
      canceledState={false}
      subscription={null}
    />
  )
}

// The whole sentence of one element, whatever spans it is split into.
function paragraph(text: string) {
  return screen.getByText((_, el) => el?.tagName === "P" && el.textContent === text)
}

describe("BillingSection — dates are the same day on server and browser", () => {
  const savedTz = process.env.TZ
  afterEach(() => { process.env.TZ = savedTz })

  it("prints the UTC day even in a zone where it is still the day before", () => {
    // 03:00Z on the 29th is the evening of the 28th in Los Angeles; the server
    // (UTC) prints the 29th, so the browser must too or hydration mismatches.
    process.env.TZ = "America/Los_Angeles"
    render(
      <BillingSection
        contactEmail="kirill@radaric.pro"
        hasActiveAccess
        subscriptionActive={false}
        complimentaryAccessUntil="2026-10-29T03:00:00.000Z"
        launchTrial
        nowMs={NOW_MS}
        successState={false}
        canceledState={false}
        subscription={null}
      />
    )
    expect(screen.getAllByText(/October 29, 2026/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/October 28, 2026/)).not.toBeInTheDocument()
  })
})

describe("BillingSection — referral trial (RAD-419)", () => {
  it("reads as a free trial with no card on file, not as a courtesy comp", () => {
    renderComp(7, true)

    expect(screen.getByText("Free trial")).toBeInTheDocument()
    expect(
      paragraph(
        "Your 7-day Lite trial runs through October 29, 2026 · 7 days left. No card on file — nothing will be charged. X/Twitter feeds are part of Pro."
      )
    ).toBeInTheDocument()
    expect(screen.getByText("Pick a plan to keep going after your trial")).toBeInTheDocument()
    expect(
      paragraph(
        "When your trial ends on October 29, 2026, choose a plan to keep your feeds and the filters that learned your taste."
      )
    ).toBeInTheDocument()
    // Plans stay visible; the manual-comp copy does not appear.
    expect(screen.getByText("Radaric Lite")).toBeInTheDocument()
    expect(screen.queryByText("Complimentary access")).not.toBeInTheDocument()
    expect(screen.queryByText(/courtesy of the team/i)).not.toBeInTheDocument()
    expect(screen.queryByText("Keep your access going")).not.toBeInTheDocument()
  })

  it("switches the heading to 'ending' at two days left, and says '1 day'", () => {
    renderComp(2, true)
    expect(screen.getByText("Your free trial is ending")).toBeInTheDocument()
    expect(paragraph(
      "Your 7-day Lite trial runs through October 24, 2026 · 2 days left. No card on file — nothing will be charged. X/Twitter feeds are part of Pro."
    )).toBeInTheDocument()
    cleanup()

    renderComp(1, true)
    expect(screen.getByText("Your free trial is ending")).toBeInTheDocument()
    expect(screen.getByText(/· 1 day left\./)).toBeInTheDocument()
  })

  it("keeps the 'keep going' heading at three days left", () => {
    renderComp(3, true)
    expect(screen.getByText("Pick a plan to keep going after your trial")).toBeInTheDocument()
    expect(screen.queryByText("Your free trial is ending")).not.toBeInTheDocument()
  })

  it("an ended trial falls back to the plain plan choice", () => {
    renderComp(-1, true)
    expect(screen.getByText("Choose your plan")).toBeInTheDocument()
    expect(screen.queryByText("Free trial")).not.toBeInTheDocument()
  })
})

describe("BillingSection — manual comp copy (RAD-419)", () => {
  it.each([undefined, false])("launchTrial=%j keeps today's courtesy copy word for word", (launchTrial) => {
    renderComp(30, launchTrial)

    expect(screen.getByText("Complimentary access")).toBeInTheDocument()
    expect(
      paragraph(
        "You have complimentary access to Radaric, courtesy of the team, through November 21, 2026. 30 days remaining."
      )
    ).toBeInTheDocument()
    expect(paragraph("Includes everything except Twitter/X account parsing.")).toBeInTheDocument()
    expect(screen.getByText("Keep your access going")).toBeInTheDocument()
    expect(
      paragraph(
        "When your complimentary access ends, pick a plan to keep your feeds and learned filters — no rush."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("Free trial")).not.toBeInTheDocument()
  })

  // A hand-granted week used to read "ending" from day one (the old ≤7-day
  // rule); like the referral trial it now switches only at two days left.
  it.each([7, 5, 3])("%i days left keeps the forward-looking heading", (daysLeft) => {
    renderComp(daysLeft, false)
    expect(screen.getByText("Keep your access going")).toBeInTheDocument()
    expect(screen.queryByText("Your complimentary access is ending")).not.toBeInTheDocument()
  })

  it("at two days left switches to the 'ending' copy", () => {
    renderComp(2, false)
    expect(screen.getByText("Your complimentary access is ending")).toBeInTheDocument()
    expect(
      paragraph(
        "Your complimentary access ends October 24, 2026. Subscribe to keep your feeds and the filters that learned your taste."
      )
    ).toBeInTheDocument()
  })
})
