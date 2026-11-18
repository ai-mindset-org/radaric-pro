/**
 * mapStripeStatus — TDD RED tests (RAD-148)
 *
 * Pure function that maps a raw Stripe subscription status string to the
 * internal SubscriptionStatus enum. Tests cover 8 AC + 3 EC; no ERR cases
 * (function must never throw).
 *
 * Spec criteria: AC-1 through AC-8, EC-1 through EC-3
 */

import { describe, it, expect } from "vitest"
import { SubscriptionStatus } from "@prisma/client"
import { mapStripeStatus } from "@/lib/stripe-status-map"

// ---------------------------------------------------------------------------
// Acceptance Criteria — known Stripe status strings (AC-1 → AC-8)
// ---------------------------------------------------------------------------

describe("mapStripeStatus — Acceptance Criteria", () => {
  it.each([
    ["AC-1", "active",             SubscriptionStatus.ACTIVE],
    ["AC-2", "trialing",           SubscriptionStatus.TRIALING],
    ["AC-3", "past_due",           SubscriptionStatus.PAST_DUE],
    ["AC-4", "canceled",           SubscriptionStatus.CANCELED],
    ["AC-5", "unpaid",             SubscriptionStatus.UNPAID],
    ["AC-6", "incomplete",         SubscriptionStatus.INCOMPLETE],
    ["AC-7", "incomplete_expired", SubscriptionStatus.INCOMPLETE_EXPIRED],
    ["AC-8", "paused",             SubscriptionStatus.PAUSED],
  ])("%s: maps %j to %s", (_criterion, input, expected) => {
    expect(mapStripeStatus(input)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Edge Cases (EC-1 → EC-3)
// ---------------------------------------------------------------------------

describe("mapStripeStatus — Edge Cases", () => {
  it("EC-1: unrecognized status 'future_stripe_status' → UNKNOWN", () => {
    expect(mapStripeStatus("future_stripe_status")).toBe(SubscriptionStatus.UNKNOWN)
  })

  it("EC-2: empty string '' → UNKNOWN", () => {
    expect(mapStripeStatus("")).toBe(SubscriptionStatus.UNKNOWN)
  })

  it("EC-3: uppercase 'ACTIVE' → UNKNOWN (case-sensitive; Stripe always sends lowercase)", () => {
    expect(mapStripeStatus("ACTIVE")).toBe(SubscriptionStatus.UNKNOWN)
  })
})
