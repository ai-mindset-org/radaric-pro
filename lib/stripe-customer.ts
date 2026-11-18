import { getStripe } from "@/lib/stripe"

// Always create a fresh Stripe customer when there's no existing link on the
// User row. We deliberately do NOT search Stripe by email first — see RAD-223.
// Email is not a unique identifier of identity (deleted-then-re-registered
// accounts, two unrelated users sharing an email), so a search-then-reuse
// would silently inherit another account's payment methods, billing history,
// and active subscriptions. The DB `User.stripeCustomerId` column is the
// canonical link; `metadata.userId` on the Stripe customer is the audit
// trail.
export async function getOrCreateStripeCustomer(params: {
  userId: string
  email: string
  existingStripeCustomerId: string | null
}): Promise<string> {
  const { userId, email, existingStripeCustomerId } = params

  if (existingStripeCustomerId) {
    return existingStripeCustomerId
  }

  const stripe = getStripe()
  const created = await stripe.customers.create({ email, metadata: { userId } })
  return created.id
}
