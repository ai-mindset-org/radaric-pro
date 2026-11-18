import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { detectRSSFeed } from "@/lib/parsers/rss"
import { checkUserRateLimit, RATE_LIMITS } from "@/lib/rate-limit"
import { isEmailVerified } from "@/lib/email-verification"
import { SSE_HEADERS } from "@/lib/sse"

export const FILE_SIZE_LIMIT = 5 * 1024 * 1024
/** Cap on pasted text sent to the LLM extractor (untrusted input, paid call). */
export const MAX_EXTRACTION_CHARS = 20_000
import { parseOpml } from "@/lib/opml-parser"
import { isAllowedUrl } from "@/lib/url-validation"
import { extractFeedsWithLLM } from "@/lib/feed-extraction"
import type { ExtractedFeed } from "@/lib/onboarding-types"

async function detectRSSFeedWithTimeout(url: string, timeoutMs = 10000): Promise<string | null> {
  if (!isAllowedUrl(url)) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const result = await Promise.race([
      detectRSSFeed(url),
      new Promise<null>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(null))
      }),
    ])
    clearTimeout(timer)
    return result
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth
  const { userId, role } = auth

  // RAD-296: bounded per-user outbound work — this path fetches and parses
  // every pasted URL (feeds + site discovery).
  const limited = checkUserRateLimit("onboarding-parse-feeds", userId, role, RATE_LIMITS.onboardingParseFeeds)
  if (limited) return limited

  try {
    const fd = await request.formData()
    const text = fd.get("text") as string | null
    const file = fd.get("file") as File | null

    if (file && file.size > FILE_SIZE_LIMIT) {
      return Response.json({ error: "File too large. Max 5 MB." }, { status: 400 })
    }

    if (!text?.trim() && !file) {
      return new Response(JSON.stringify({ error: "No input" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (e: Record<string, unknown>) => {
          if (request.signal.aborted) return
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
        }

        try {
          let all: ExtractedFeed[] = []

          if (file?.name.endsWith(".opml")) {
            const parsed = await parseOpml(await file.text())
            all = parsed
              .filter((f) => !f.isFeedlySpecific)
              .map((f) => ({
                url: f.xmlUrl,
                name: f.name || (() => { try { return new URL(f.xmlUrl).hostname } catch { return f.xmlUrl } })(),
                type: "RSS" as const,
                status: "found" as const,
              }))
          } else {
            // RAD-297: THIS branch calls the LLM extractor — verified accounts
            // only. OPML imports above stay open to the demo (no spend).
            if (!(await isEmailVerified(userId, role))) {
              send({ type: "error", message: "Verify your email to use AI feed discovery.", code: "EMAIL_NOT_VERIFIED" })
              ctrl.close()
              return
            }
            let c = text?.trim() || ""
            if (file) c = c ? `${c}\n${await file.text()}` : await file.text()
            if (!c) {
              send({ type: "error", message: "No feeds found." })
              ctrl.close()
              return
            }
            if (c.length > MAX_EXTRACTION_CHARS) {
              send({ type: "error", message: `Text too long (max ${MAX_EXTRACTION_CHARS.toLocaleString()} characters). Try pasting fewer feed URLs.` })
              ctrl.close()
              return
            }
            all = await extractFeedsWithLLM(c)
          }

          if (!all.length) {
            send({ type: "error", message: "No feeds found. Try pasting URLs one per line." })
            ctrl.close()
            return
          }

          // Send all feeds — already-resolved ones show as found immediately
          for (const f of all) send({ type: "feed", feed: f })

          // Only discover RSS for WEBSITE type that are still pending
          const ws = all.filter((f) => f.type === "WEBSITE" && f.status === "pending")

          for (let i = 0; i < ws.length; i += 3) {
            if (request.signal.aborted) break
            await Promise.allSettled(
              ws.slice(i, i + 3).map(async (f) => {
                if (!f.url || request.signal.aborted) return

                // Ensure URL has protocol
                const feedUrl = f.url.startsWith("http") ? f.url : `https://${f.url}`
                const rss = await detectRSSFeedWithTimeout(feedUrl)
                if (rss) {
                  f.type = "RSS"
                  f.feedUrl = rss
                  f.status = "found"
                  try {
                    const P = (await import("rss-parser")).default
                    const r = await new P().parseURL(rss)
                    if (r.items?.[0]?.title) f.recentHeadline = r.items[0].title
                  } catch {}
                } else {
                  f.status = "not_found"
                }

                send({ type: "update", feed: f })
              })
            )
          }

          send({ type: "complete", feeds: all })
        } catch (e) {
          console.error("Parse feeds error:", e)
          send({ type: "error", message: "Try pasting URLs one per line." })
        }

        ctrl.close()
      },
    })

    return new Response(stream, {
      // The shared SSE headers carry `no-transform`, which is load-bearing
      // from next 16.4.6 on: route-handler responses are now compressed
      // (Next #101280), and gzip buffers an event stream until it fills or
      // ends — this route's frames would all arrive at once at the end.
      headers: SSE_HEADERS,
    })
  } catch (e) {
    console.error("Parse feeds route error:", e)
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
