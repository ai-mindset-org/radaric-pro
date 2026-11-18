/**
 * Webhook endpoint for Parallel Monitor API
 *
 * Receives notifications when monitors detect new content.
 * POST /api/webhooks/parallel
 */

import { NextRequest, NextResponse } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { db } from "@/lib/db"
import { processParallelEvent } from "@/lib/parsers/interest"
import { resolveAccessWithReason } from "@/lib/subscription"
import { getClientIp, rateLimit, rateLimitedResponse, RATE_LIMITS } from "@/lib/rate-limit"
import crypto from "crypto"

// ============================================================================
// Payload Validation
// ============================================================================

/**
 * Normalize a Parallel monitor webhook payload to `{ eventType, monitorId,
 * eventGroupId }`.
 *
 * Parallel migrated monitor deliveries to the Standard Webhooks envelope
 * (docs.parallel.ai/monitor-api/monitor-webhooks): `{ type, timestamp, data: {
 * monitor_id, event: { event_group_id } } }`. The pre-migration flat shape
 * `{ event_type, monitor_id, event_group_id }` is still accepted — Parallel
 * keeps the legacy signing scheme alive for existing accounts and in-flight
 * retries can carry it. On 2026-10-07 the handler only understood the flat
 * shape, so every post-migration delivery answered `400 Invalid payload
 * structure` and all autonomous collection silently stopped.
 */
export function normalizeParallelPayload(
  payload: unknown
): { eventType: string; monitorId?: string; eventGroupId?: string } | null {
  if (payload == null || typeof payload !== "object") return null
  const p = payload as Record<string, unknown>
  const data =
    p.data != null && typeof p.data === "object" ? (p.data as Record<string, unknown>) : {}
  const event =
    data.event != null && typeof data.event === "object"
      ? (data.event as Record<string, unknown>)
      : {}

  const eventType =
    typeof p.type === "string" ? p.type : typeof p.event_type === "string" ? p.event_type : null
  if (!eventType) return null

  const monitorId =
    typeof data.monitor_id === "string"
      ? data.monitor_id
      : typeof p.monitor_id === "string"
        ? p.monitor_id
        : undefined

  const eventGroupId =
    typeof event.event_group_id === "string"
      ? event.event_group_id
      : typeof data.event_group_id === "string"
        ? data.event_group_id
        : typeof p.event_group_id === "string"
          ? p.event_group_id
          : undefined

  return { eventType, monitorId, eventGroupId }
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify a Parallel webhook signature.
 *
 * Parallel signs HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${rawBody}`
 * and sends the base64 digest in `webhook-signature` as one or more
 * space-delimited `v1,<base64>` entries (multiple = secret rotation). Two key
 * derivations are accepted because Parallel has two live schemes:
 *
 *  - **Standard Webhooks** (current): strip the `whsec_` prefix from the account
 *    secret, base64-decode the remainder, use those bytes as the HMAC key.
 *  - **Legacy** (pre-migration, still supported for existing accounts): use the
 *    secret string itself (including any `whsec_` prefix) as the UTF-8 key.
 *
 * See docs.parallel.ai/resources/webhook-setup.
 */
export function verifyWebhookSignature(
  webhookId: string | null,
  webhookTimestamp: string | null,
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!webhookId || !webhookTimestamp || !signatureHeader) {
    return false
  }

  const signed = `${webhookId}.${webhookTimestamp}.${rawBody}`
  const candidates: Buffer[] = []

  // Legacy: the whole secret (prefix included) as the UTF-8 key.
  candidates.push(
    Buffer.from(crypto.createHmac("sha256", secret).update(signed).digest("base64"))
  )

  // Standard Webhooks: `whsec_` stripped, remainder base64-decoded.
  const trimmed = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
  const key = Buffer.from(trimmed, "base64")
  if (key.length > 0) {
    candidates.push(
      Buffer.from(crypto.createHmac("sha256", key).update(signed).digest("base64"))
    )
  }

  // Header may carry several whitespace-delimited "v1,<base64>" signatures (rotation).
  for (const part of signatureHeader.split(/\s+/)) {
    const comma = part.indexOf(",")
    if (comma === -1) continue
    const version = part.slice(0, comma)
    const sig = part.slice(comma + 1)
    if (version !== "v1" || !sig) continue
    const sigBuf = Buffer.from(sig)
    for (const expected of candidates) {
      if (sigBuf.length === expected.length && crypto.timingSafeEqual(sigBuf, expected)) {
        return true
      }
    }
  }
  return false
}

// ============================================================================
// Webhook Handler
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    // Rate limiting by IP — the shared limiter derives the real client IP
    // (the CDN's X-Real-IP / the last XFF hop). The old code keyed on XFF[0], which
    // is the CDN's own address: one bucket for every visitor. RAD-296.
    const clientIp = getClientIp(request.headers)
    const limitResult = rateLimit("parallel-webhook", clientIp, RATE_LIMITS.parallelWebhook.limit, RATE_LIMITS.parallelWebhook.windowMs)
    if (!limitResult.ok) {
      console.warn(`[Parallel Webhook] Rate limit exceeded for IP: ${clientIp}`)
      return rateLimitedResponse(limitResult.retryAfterSeconds)
    }

    const settings = await db.settings.findFirst()

    // Get raw body + Standard Webhooks headers for signature verification.
    const rawBody = await request.text()
    const webhookId = request.headers.get("webhook-id")
    const webhookTimestamp = request.headers.get("webhook-timestamp")
    const signatureHeader = request.headers.get("webhook-signature")

    // Verify signature. Unverified payloads are never processed in ANY
    // environment (RAD-289): the old `NODE_ENV !== "production"` skip was an
    // attack recipe the moment the source is public — and a trap for self-hosters
    // running a non-standard NODE_ENV. The only escape hatch is explicit and loud.
    if (settings?.parallelWebhookSecret) {
      if (!verifyWebhookSignature(webhookId, webhookTimestamp, rawBody, signatureHeader, settings.parallelWebhookSecret)) {
        console.error("[Parallel Webhook] Invalid signature")
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    } else if (process.env.PARALLEL_WEBHOOK_INSECURE === "1") {
      console.warn("[Parallel Webhook] INSECURE: PARALLEL_WEBHOOK_INSECURE=1 — processing an unverified payload. Never set this outside local development.")
    } else {
      console.error("[Parallel Webhook] Webhook secret not configured — rejecting unverified payload")
      return NextResponse.json({ error: "Webhook not configured" }, { status: 503 })
    }

    // Parse and validate payload
    let payload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      console.error("[Parallel Webhook] Invalid JSON payload")
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
    }

    // Normalize the two envelope generations (Standard Webhooks `{type, data}`
    // and the legacy flat `{event_type, …}`) into one shape.
    const normalized = normalizeParallelPayload(payload)
    if (!normalized) {
      console.error("[Parallel Webhook] Invalid payload structure:", rawBody.slice(0, 300))
      return NextResponse.json({ error: "Invalid payload structure" }, { status: 400 })
    }

    console.log("[Parallel Webhook] Received event:", normalized.eventType)

    // Handle monitor.event.detected
    if (normalized.eventType === "monitor.event.detected") {
      const { monitorId: monitor_id, eventGroupId: event_group_id } = normalized
      if (!monitor_id || !event_group_id) {
        console.error(
          "[Parallel Webhook] Invalid monitor event: missing monitor_id or event_group_id"
        )
        return NextResponse.json({ error: "Invalid monitor event payload" }, { status: 400 })
      }

      // Find source by parallelMonitorId
      const source = await db.feed.findFirst({
        where: { parallelMonitorId: monitor_id },
      })

      if (!source) {
        console.warn(`[Parallel Webhook] Unknown monitor: ${monitor_id}`)
        // Return 200 to prevent retries for unknown monitors
        return NextResponse.json({ status: "ignored", reason: "unknown_monitor" })
      }

      if (!source.isActive) {
        console.log(`[Parallel Webhook] Source ${source.name} is inactive, ignoring`)
        return NextResponse.json({ status: "ignored", reason: "source_inactive" })
      }

      if (!source.userId) {
        console.error(`[Parallel Webhook] Source ${source.name} has no userId`)
        return NextResponse.json({ status: "error", reason: "source_missing_user" }, { status: 500 })
      }

      // RAD-323 access + spend gate: one DB-backed resolution replaces the old
      // isActive-only check. Unknown (DB failure) → 503 so a paying owner's event
      // is retried rather than dropped; denied (no user row, inactive, or lapsed
      // access) → a deliberate 200 skip that also stops Parallel re-delivering.
      let access: Awaited<ReturnType<typeof resolveAccessWithReason>>
      try {
        access = await resolveAccessWithReason(source.userId)
      } catch (err) {
        Sentry.captureException(err, { tags: { source: "parallel-webhook", stage: "access-check" } })
        console.error(`[Parallel Webhook] Access check failed for source ${source.name}:`, err)
        return NextResponse.json({ error: "Access check failed", retryable: true }, { status: 503 })
      }
      if (!access.allowed) {
        if (access.unverified) {
          // RAD-297: the owner may verify any moment — ask Parallel to retry so
          // the detected event is not dropped permanently.
          console.log(`[Parallel Webhook] Source ${source.name}: owner email unverified — retry requested (RAD-297)`)
          return NextResponse.json({ error: "Owner email unverified", retryable: true }, { status: 503 })
        }
        console.log(`[Parallel Webhook] Source ${source.name}: owner access inactive — skipping (RAD-323)`)
        return NextResponse.json({ status: "ignored", reason: "access_inactive" })
      }

      // Process events
      try {
        const result = await processParallelEvent(source.id, event_group_id, source.userId)
        console.log(`[Parallel Webhook] Processed: ${result.created} created, ${result.skipped} skipped`)

        return NextResponse.json({
          status: "ok",
          created: result.created,
          skipped: result.skipped,
        })
      } catch (processError) {
        const errorMessage = processError instanceof Error ? processError.message : "Processing failed"
        console.error(`[Parallel Webhook] Error processing event:`, processError)

        // Distinguish temporary vs permanent errors
        const isTemporaryError =
          errorMessage.includes("fetch") ||
          errorMessage.includes("network") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("rate limit")

        if (isTemporaryError) {
          // Return 503 so Parallel can retry
          return NextResponse.json(
            { error: "Temporary processing error", retryable: true },
            { status: 503 }
          )
        }

        // Permanent error - return 200 to prevent retries
        return NextResponse.json({
          status: "error",
          error: errorMessage,
          retryable: false,
        })
      }
    }

    // Unknown event type. A monitor.execution.* event (completed/failed) is a
    // run-status notice, not a detection — ignored with 200 so Parallel does
    // not retry, but surfaced so a failing monitor is visible in the logs
    // (silent collection failure is exactly the class RAD-397 fixes).
    if (normalized.eventType.startsWith("monitor.execution.")) {
      console.warn(`[Parallel Webhook] Monitor execution event ignored: ${normalized.eventType}`)
    }
    console.log(`[Parallel Webhook] Unknown event type: ${normalized.eventType}`)
    return NextResponse.json({ status: "ignored", reason: "unknown_event_type" })
  } catch (error) {
    console.error("[Parallel Webhook] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

// Allow GET for health check
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "parallel-webhook",
    timestamp: new Date().toISOString(),
  })
}
