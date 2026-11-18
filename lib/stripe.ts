import Stripe from "stripe"

// Lazy singleton — constructed on first call so build-time module evaluation
// doesn't fail when STRIPE_SECRET_KEY is unset (matches the parallel webhook
// pattern where the route returns 503 if the secret is missing). Callers do
// `const stripe = getStripe()` at the top of their handler.
let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (_stripe) return _stripe
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set")
  _stripe = new Stripe(key, {
    apiVersion: "2026-03-25.dahlia",
    typescript: true,
    maxNetworkRetries: 2,
  })
  return _stripe
}

// Four prices: two tiers (Pro / Lite) × two intervals (monthly / yearly).
// The Pro env vars keep their original names (STRIPE_PRICE_MONTHLY/YEARLY) so
// existing environments need no change — they simply ARE the Pro prices now.
// Lite adds two new vars. The tier of a subscription is derived from its stored
// `stripePriceId` at read time (no DB column) — see lib/entitlements.ts.
export const STRIPE_PRICES = {
  pro_monthly: process.env.STRIPE_PRICE_MONTHLY ?? "",
  pro_yearly: process.env.STRIPE_PRICE_YEARLY ?? "",
  lite_monthly: process.env.STRIPE_PRICE_LITE_MONTHLY ?? "",
  lite_yearly: process.env.STRIPE_PRICE_LITE_YEARLY ?? "",
} as const

export type StripePriceKey = keyof typeof STRIPE_PRICES

export function getAppUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  return raw.replace(/\/+$/, "")
}
