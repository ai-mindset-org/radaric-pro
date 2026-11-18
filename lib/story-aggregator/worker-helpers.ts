/* eslint-disable @typescript-eslint/no-explicit-any -- GramJS has no exported types for messages, media and documents */
/**
 * Helper functions for the Story Aggregator worker.
 * Extracted to a separate module to avoid triggering worker.ts side effects
 * (HTTP server, GramJS connection) when importing for testing.
 */

import { uploadTelegramMedia, uploadTelegramThumb, type UploadedMedia } from "../blob-storage"

// ---------------------------------------------------------------------------
// Media download result type
// ---------------------------------------------------------------------------

export interface MediaResult {
  url: string | null
  type: string | null
  /** Poster image (document thumbnail); for photos it equals `url`. */
  thumbUrl: string | null
  skipped: boolean
}

const MEDIA_DOWNLOAD_CONCURRENCY = 5

/** Classify a document by its attributes without importing GramJS. */
function detectDocumentType(media: any): string {
  const attrs = media?.document?.attributes || []
  if (attrs.some((a: any) => a.className === "DocumentAttributeVideo")) return "video"
  if (attrs.some((a: any) => a.className === "DocumentAttributeAudio")) return "audio"
  return "document"
}

// ---------------------------------------------------------------------------
// downloadMessageMedia
// ---------------------------------------------------------------------------

/**
 * Download and upload a single message's media to R2.
 * Uses ALLOWLIST approach: only MessageMediaPhoto, MessageMediaDocument, and
 * MessageMediaWebPage-with-photo are mirrored. Documents larger than 50MB skip
 * the body but still mirror the poster. Never throws — returns
 * `{ url: null, type: null, thumbUrl: null, skipped: true }` on any error.
 */
export async function downloadMessageMedia(
  client: any,
  message: any,
  channelUsername: string
): Promise<MediaResult> {
  const media = message.media
  if (!media) return { url: null, type: null, thumbUrl: null, skipped: true }

  const className = media.className
  const isPhoto = className === "MessageMediaPhoto"
  const isDocument = className === "MessageMediaDocument"
  const isWebPageWithPhoto =
    className === "MessageMediaWebPage" && Boolean(media.webpage?.photo)

  // ALLOWLIST: only photo, document and webpage-photo media
  if (!isPhoto && !isDocument && !isWebPageWithPhoto) {
    return { url: null, type: null, thumbUrl: null, skipped: true }
  }

  try {
    // Pre-check document size before downloading (avoid downloading 500MB only to reject).
    // The body is skipped, but the poster is still worth mirroring.
    if (isDocument && media.document?.size) {
      const sizeMB = Number(media.document.size) / 1024 / 1024
      if (sizeMB > 50) {
        console.log(`[Worker] Skipping large file (${sizeMB.toFixed(1)}MB) for msg ${message.id}`)
        // The renderer turns this marker into a "Media not mirrored · Open in
        // Telegram" row; without it an oversized video would be indistinguishable
        // from a text post (RAD-359).
        const thumbUrl = await uploadTelegramThumb(client, message, channelUsername)
        return {
          url: `tg://too-large/${channelUsername}/${message.id}`,
          type: detectDocumentType(media),
          thumbUrl,
          skipped: true,
        }
      }
    }

    const result: UploadedMedia = await uploadTelegramMedia(client, message, channelUsername)
    return {
      url: result.url,
      type: result.type,
      thumbUrl: result.thumbUrl ?? null,
      skipped: false,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn(`[Worker] Media download failed for msg ${message.id}: ${msg}`)
    return { url: null, type: null, thumbUrl: null, skipped: true }
  }
}

// ---------------------------------------------------------------------------
// downloadMediaBatch (concurrency-limited)
// ---------------------------------------------------------------------------

/**
 * Download media for multiple messages with concurrency limiting.
 * Returns results in the same order as the input messages array.
 * Limits to 5 concurrent downloads (3 when a deadline-bound caller asks) to
 * avoid memory pressure and rate limits. A `deadline` (epoch ms) stops the
 * batch from STARTING further downloads once it passes — in-flight downloads
 * still finish, and messages not started resolve as skipped. `onResult` hears
 * each result the moment it lands, so a caller that stops waiting (a hard cap)
 * keeps what already finished.
 */
export async function downloadMediaBatch(
  client: any,
  messages: any[],
  channelUsername: string,
  options: {
    concurrency?: number
    deadline?: number
    onResult?: (index: number, result: MediaResult) => void
  } = {}
): Promise<MediaResult[]> {
  const concurrency = options.concurrency ?? MEDIA_DOWNLOAD_CONCURRENCY
  const results: MediaResult[] = new Array(messages.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < messages.length) {
      const idx = cursor++
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        results[idx] = { url: null, type: null, thumbUrl: null, skipped: true }
        continue
      }
      results[idx] = await downloadMessageMedia(client, messages[idx], channelUsername)
      options.onResult?.(idx, results[idx])
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, messages.length) },
      () => worker()
    )
  )
  return results
}

// ---------------------------------------------------------------------------
// extractPollText
// ---------------------------------------------------------------------------

/**
 * Extract poll question + answers as text from a GramJS MessageMediaPoll.
 * Returns null if the message has no poll media.
 *
 * Handles both plain string and TextWithEntities ({ text: string }) shapes
 * for question and answer fields.
 */
export function extractPollText(message: any): string | null {
  if (!message.media) return null
  if (message.media.className !== "MessageMediaPoll") return null

  const poll = message.media.poll
  const rawQuestion = poll.question
  const questionText =
    typeof rawQuestion === "string" ? rawQuestion : rawQuestion.text

  const answers: string[] = (poll.answers || []).map((answer: any) => {
    const rawText = answer.text
    return typeof rawText === "string" ? rawText : rawText.text
  })

  if (answers.length === 0) {
    return `[Опрос] ${questionText}`
  }

  const numberedAnswers = answers.map((a, i) => `${i + 1}. ${a}`).join("\n")
  return `[Опрос] ${questionText}\n${numberedAnswers}`
}
