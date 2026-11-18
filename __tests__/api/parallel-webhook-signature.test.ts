/**
 * Parallel webhook signature verification — Standard Webhooks scheme.
 *
 * Regression for the bug that silently killed all autonomous collection on prod:
 * the verifier previously checked an `x-parallel-signature` hex HMAC of the raw
 * body, but Parallel signs HMAC-SHA256 of `${id}.${ts}.${body}`, base64, in a
 * `webhook-signature: v1,<sig>` header. Verification could therefore NEVER pass,
 * so every monitor event was rejected and no material was ever ingested.
 * Spec: docs.parallel.ai/resources/webhook-setup#security--verification
 */

import { describe, it, expect } from "vitest"
import crypto from "node:crypto"
import { verifyWebhookSignature } from "@/app/api/webhooks/parallel/route"

const SECRET = "test_webhook_secret"
const ID = "msg_2abc"
const TS = "1700000000"
const BODY = JSON.stringify({ event_type: "monitor.event.detected", monitor_id: "m1", event_group_id: "g1" })

function sign(id: string, ts: string, body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64")
}

describe("verifyWebhookSignature (Standard Webhooks)", () => {
  it("accepts a correctly-signed Parallel webhook", () => {
    const header = `v1,${sign(ID, TS, BODY, SECRET)}`
    expect(verifyWebhookSignature(ID, TS, BODY, header, SECRET)).toBe(true)
  })

  it("accepts when one of several space-delimited signatures matches (rotation)", () => {
    const good = `v1,${sign(ID, TS, BODY, SECRET)}`
    const stale = `v1,${sign(ID, TS, BODY, "old_secret")}`
    expect(verifyWebhookSignature(ID, TS, BODY, `${stale} ${good}`, SECRET)).toBe(true)
  })

  it("tolerates any whitespace between rotated signatures", () => {
    const good = `v1,${sign(ID, TS, BODY, SECRET)}`
    const stale = `v1,${sign(ID, TS, BODY, "old_secret")}`
    expect(verifyWebhookSignature(ID, TS, BODY, `${stale}\t${good}`, SECRET)).toBe(true)
    expect(verifyWebhookSignature(ID, TS, BODY, `${stale}  ${good}`, SECRET)).toBe(true)
  })

  it("rejects a wrong secret", () => {
    const header = `v1,${sign(ID, TS, BODY, "wrong_secret")}`
    expect(verifyWebhookSignature(ID, TS, BODY, header, SECRET)).toBe(false)
  })

  it("rejects a tampered body (signature over id.ts.body)", () => {
    const header = `v1,${sign(ID, TS, BODY, SECRET)}`
    expect(verifyWebhookSignature(ID, TS, '{"event_type":"tampered"}', header, SECRET)).toBe(false)
  })

  it("rejects when the id or timestamp differ from what was signed", () => {
    const header = `v1,${sign(ID, TS, BODY, SECRET)}`
    expect(verifyWebhookSignature("other_id", TS, BODY, header, SECRET)).toBe(false)
    expect(verifyWebhookSignature(ID, "9999999999", BODY, header, SECRET)).toBe(false)
  })

  it("rejects missing headers", () => {
    const header = `v1,${sign(ID, TS, BODY, SECRET)}`
    expect(verifyWebhookSignature(null, TS, BODY, header, SECRET)).toBe(false)
    expect(verifyWebhookSignature(ID, null, BODY, header, SECRET)).toBe(false)
    expect(verifyWebhookSignature(ID, TS, BODY, null, SECRET)).toBe(false)
  })

  it("rejects the OLD broken scheme (hex HMAC of the raw body only) — regression guard", () => {
    const oldHex = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex")
    expect(verifyWebhookSignature(ID, TS, BODY, oldHex, SECRET)).toBe(false)
    expect(verifyWebhookSignature(ID, TS, BODY, `v1,${oldHex}`, SECRET)).toBe(false)
  })
})
