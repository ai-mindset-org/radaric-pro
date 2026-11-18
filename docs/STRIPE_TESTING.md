# Stripe Billing Setup

Stripe is **optional**. Radaric runs and serves content without it — you only
need billing to sell subscription plans on an instance that is not self-hosted.

- In self-hosted mode (`SELF_HOSTED=true`) every account is unlocked, and the
  checkout and billing-portal routes refuse to run with `400 SELF_HOSTED` even
  if Stripe keys are present (`lib/self-hosted.ts`, `lib/subscription.ts`,
  `app/api/stripe/*`). No Stripe configuration is needed.
- A single-account install needs no Stripe either: the first account in an empty
  database becomes ADMIN, and ADMIN bypasses every access gate.
- For everything else on the instance — Docker quick start, AI keys, feature
  map — see [SELF_HOSTING.md](../SELF_HOSTING.md). This page covers only the
  Stripe side.

## 1. What billing does

- **Checkout** — hosted redirect flow for the Pro and Lite tiers, monthly or
  yearly. No publishable key is needed and no Stripe.js is loaded.
- **Customer Portal** — subscribers manage, cancel or switch plans.
- **Webhooks** — `POST /api/webhooks/stripe` syncs subscription state into the
  database.

Access for a non-admin account is granted when it has an ACTIVE or TRIALING
subscription, a PAST_DUE subscription still inside its period, a comp grant, or
is in the 24-hour onboarding demo window (accounts that have not completed
onboarding, measured from account creation). The tier is derived at read time
from the subscription's stored price id — Pro parses Twitter/X feeds, Lite does
not. Nothing tier-related is stored separately.

## 2. Environment variables

| Variable | Value |
|----------|-------|
| `STRIPE_SECRET_KEY` | Server API key with write access to Checkout Sessions, Billing Portal Sessions and Customers. A restricted key MUST include those scopes, or checkout and portal creation fail at runtime. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint you create in §3. Per-endpoint — the local `stripe listen` secret and the Dashboard secret are different values. |
| `STRIPE_PRICE_MONTHLY` | Pro monthly price id |
| `STRIPE_PRICE_YEARLY` | Pro yearly price id |
| `STRIPE_PRICE_LITE_MONTHLY` | Lite monthly price id |
| `STRIPE_PRICE_LITE_YEARLY` | Lite yearly price id |
| `NEXT_PUBLIC_APP_URL` | Public base URL of the instance; used to build Checkout success/cancel and Portal return URLs |

All seven are read in `lib/stripe.ts` (`getStripe`, `STRIPE_PRICES`,
`getAppUrl`), in `app/api/webhooks/stripe/route.ts`, and in the routes under
`app/api/stripe/`.

- If you sell only one tier, set only that tier's price variables. Checkout for
  a tier with unset prices answers `400 "Selected plan is not available"`.
- Sandbox and live mode have separate keys, products and price ids. Values do
  not carry over between modes.
- The billing routes fail cleanly when Stripe is unconfigured — the rest of the
  app is unaffected.

## 3. Stripe Dashboard setup

1. **Create products and prices.** One product per tier you sell, each with a
   recurring monthly and yearly price. Copy the four price ids into the
   corresponding variables (§2).
2. **Add a webhook endpoint.**
   - URL: `https://<your-instance>/api/webhooks/stripe`
   - Events (the handler covers exactly these; unlisted events are acknowledged
     and ignored):
     `checkout.session.completed`,
     `customer.subscription.created`,
     `customer.subscription.updated`,
     `customer.subscription.deleted`,
     `invoice.paid`,
     `invoice.payment_failed`,
     `customer.deleted`,
     `charge.dispute.created`
   - Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.

   **Signature verification is REQUIRED in every environment and cannot be
   disabled.** The route returns `503` when no secret is configured, and `400`
   for a missing or invalid signature — unsigned requests are NEVER processed.
3. **Configure the Customer Portal** (Settings → Billing → Customer portal) and
   **save** it. The app creates portal sessions without passing a
   `configuration` parameter, so it relies on the account's saved default
   configuration; without one, "Manage billing" fails. Enable at least invoice
   history, payment-method update and cancellation. For the monthly↔yearly
   switch flow, enable subscription updates and list both products.
4. **Set the environment variables** on your deployment target. Unset variables
   or a missing saved portal configuration are the two most common setup
   failures.

## 4. Local testing with the Stripe CLI

1. Start the app: `npm run dev` (listens on port 3000).
2. Log in to the Stripe CLI (`stripe login`) and forward webhooks:

   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

3. Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET` and restart the
   dev server. The secret changes with every `stripe listen` session.
4. Register an account, complete onboarding and subscribe with a test card:

   | Card | Scenario |
   |------|----------|
   | `4242 4242 4242 4242` | Success |
   | `4000 0025 0000 3155` | Requires 3D Secure |
   | `4000 0000 0000 9995` | Insufficient funds |
   | `4000 0000 0000 0341` | Attach succeeds, charge fails → `invoice.payment_failed` |
   | `4000 0000 0000 0002` | Declined |

5. Confirm `stripe listen` shows the expected events, then check the portal
   (cancel, update card, switch plan) and the access flip on the gated pages.
6. To test idempotency, resend a delivered event — the duplicate is a `200`
   no-op:

   ```bash
   stripe events resend <event_id> --webhook-endpoint=<we_...>
   ```

## 5. Operational notes

- Webhook handlers re-fetch the subscription from Stripe; they never trust the
  event payload, so out-of-order delivery is safe by design.
- `StripeEvent.id` is the idempotency fence — duplicate deliveries return `200`
  without reprocessing. On a handler failure the fence row is deleted so Stripe
  retries.
- **Keep price ids stable.** The tier is derived from the stored price id at
  read time. If you replace a Lite price and repoint `STRIPE_PRICE_LITE_*` at
  the new id, existing subscribers still on the old id no longer map to a tier:
  the entitlement layer fails open (they keep Pro features) and logs a Sentry
  warning. Keep the old id in the environment while subscribers remain on it,
  and rotate only after they have moved.
