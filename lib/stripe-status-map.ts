import { SubscriptionStatus } from "@prisma/client"

const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active:             SubscriptionStatus.ACTIVE,
  trialing:           SubscriptionStatus.TRIALING,
  past_due:           SubscriptionStatus.PAST_DUE,
  canceled:           SubscriptionStatus.CANCELED,
  unpaid:             SubscriptionStatus.UNPAID,
  incomplete:         SubscriptionStatus.INCOMPLETE,
  incomplete_expired: SubscriptionStatus.INCOMPLETE_EXPIRED,
  paused:             SubscriptionStatus.PAUSED,
}

export function mapStripeStatus(s: string): SubscriptionStatus {
  return STRIPE_STATUS_MAP[s] ?? SubscriptionStatus.UNKNOWN
}
