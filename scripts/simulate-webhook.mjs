#!/usr/bin/env node
/**
 * Simulates a Stripe webhook delivery to the local dev server.
 * Usage: node scripts/simulate-webhook.mjs <event_type> <subscription_id>
 *
 * Fetches the real subscription from Stripe, constructs a signed event,
 * and POSTs it to localhost:3000/api/webhooks/stripe.
 */
import Stripe from "stripe"
import crypto from "crypto"

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const WEBHOOK_URL = "http://localhost:3000/api/webhooks/stripe"

if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) {
  console.error("Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in .env")
  process.exit(1)
}

const eventType = process.argv[2] || "checkout.session.completed"
const subscriptionId = process.argv[3]

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" })

// Fetch the latest checkout session
const sessions = await stripe.checkout.sessions.list({ limit: 1 })
const session = sessions.data[0]

if (!session) {
  console.error("No checkout sessions found")
  process.exit(1)
}

console.log(`Session: ${session.id}, sub: ${session.subscription}, customer: ${session.customer}`)

// Construct a fake but properly-signed event
const eventId = `evt_local_${Date.now()}`
const event = {
  id: eventId,
  object: "event",
  type: eventType,
  data: {
    object: eventType === "checkout.session.completed"
      ? session
      : eventType.startsWith("customer.subscription")
        ? await stripe.subscriptions.retrieve(subscriptionId || session.subscription)
        : session,
  },
  created: Math.floor(Date.now() / 1000),
}

const payload = JSON.stringify(event)
const timestamp = Math.floor(Date.now() / 1000)
const signature = crypto
  .createHmac("sha256", WEBHOOK_SECRET)
  .update(`${timestamp}.${payload}`)
  .digest("hex")
const sigHeader = `t=${timestamp},v1=${signature}`

console.log(`Delivering ${eventType} event ${eventId}...`)

const res = await fetch(WEBHOOK_URL, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "stripe-signature": sigHeader,
  },
  body: payload,
})

console.log(`Response: ${res.status} ${res.statusText}`)
const body = await res.text()
if (body) console.log(`Body: ${body}`)
