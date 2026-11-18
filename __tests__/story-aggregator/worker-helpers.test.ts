/**
 * Tests for worker-helpers.ts.
 * extractPollText(): formats poll question + answers into a string.
 * downloadMessageMedia(): RAD-359 mirror layer — returns
 * `{ url, type, thumbUrl, skipped }`, hanging a poster on the result and
 * handling MessageMediaWebPage photos. blob-storage is mocked so the tests
 * exercise only the worker-helper decision logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { uploadTelegramMediaMock, uploadTelegramThumbMock } = vi.hoisted(() => ({
  uploadTelegramMediaMock: vi.fn(),
  uploadTelegramThumbMock: vi.fn(),
}))

vi.mock("@/lib/blob-storage", () => ({
  uploadTelegramMedia: uploadTelegramMediaMock,
  uploadTelegramThumb: uploadTelegramThumbMock,
}))

import {
  extractPollText,
  downloadMessageMedia,
} from "@/lib/story-aggregator/worker-helpers"
import { uploadTelegramMedia, uploadTelegramThumb } from "@/lib/blob-storage"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePollMessage({
  question,
  answers,
}: {
  question: string | { text: string }
  answers: Array<{ text: string | { text: string } }>
}) {
  return {
    media: {
      className: "MessageMediaPoll",
      poll: {
        question,
        answers,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractPollText", () => {
  it("returns formatted poll text with question and numbered answers (string fields)", () => {
    const message = makePollMessage({
      question: "Что выберете?",
      answers: [
        { text: "Вариант А" },
        { text: "Вариант Б" },
        { text: "Вариант В" },
      ],
    })

    const result = extractPollText(message)

    expect(result).toBe(
      "[Опрос] Что выберете?\n1. Вариант А\n2. Вариант Б\n3. Вариант В"
    )
  })

  it("handles question as TextWithEntities object { text: string }", () => {
    const message = makePollMessage({
      question: { text: "Какой дизайн лучше?" },
      answers: [{ text: "Первый" }, { text: "Второй" }],
    })

    const result = extractPollText(message)

    expect(result).toBe("[Опрос] Какой дизайн лучше?\n1. Первый\n2. Второй")
  })

  it("handles answer.text as TextWithEntities object { text: string }", () => {
    const message = makePollMessage({
      question: "Ваш выбор?",
      answers: [
        { text: { text: "Опция один" } },
        { text: { text: "Опция два" } },
      ],
    })

    const result = extractPollText(message)

    expect(result).toBe("[Опрос] Ваш выбор?\n1. Опция один\n2. Опция два")
  })

  it("returns null when message has no media (media is null)", () => {
    const message = { media: null }

    const result = extractPollText(message)

    expect(result).toBeNull()
  })

  it("returns null when media is not MessageMediaPoll (e.g. MessageMediaPhoto)", () => {
    const message = {
      media: {
        className: "MessageMediaPhoto",
        photo: { id: "abc123" },
      },
    }

    const result = extractPollText(message)

    expect(result).toBeNull()
  })

  it("returns formatted question only when answers array is empty", () => {
    const message = makePollMessage({
      question: "Только вопрос?",
      answers: [],
    })

    const result = extractPollText(message)

    expect(result).toBe("[Опрос] Только вопрос?")
  })
})

// ---------------------------------------------------------------------------
// downloadMessageMedia (RAD-359 mirror layer)
// ---------------------------------------------------------------------------

const CHANNEL = "design_digest"
const CDN = "https://cdn.example.com"
const cdn = (key: string) => `${CDN}/${key}`

const photoMessage = {
  id: 503,
  media: { className: "MessageMediaPhoto", photo: {} },
}

const videoWithThumbs = {
  id: 502,
  media: {
    className: "MessageMediaDocument",
    document: {
      size: 30_000,
      mimeType: "video/mp4",
      attributes: [{ className: "DocumentAttributeVideo" }],
      thumbs: [
        { className: "PhotoSize", type: "x", w: 320, h: 180, size: 5_000 },
      ],
    },
  },
}

const oversizedDocument = {
  id: 502,
  media: {
    className: "MessageMediaDocument",
    document: {
      size: 60_000_000,
      mimeType: "video/mp4",
      attributes: [{ className: "DocumentAttributeVideo" }],
      thumbs: [
        { className: "PhotoSize", type: "x", w: 320, h: 180, size: 5_000 },
      ],
    },
  },
}

const webpageWithPhoto = {
  id: 504,
  media: {
    className: "MessageMediaWebPage",
    webpage: { className: "WebPage", photo: {} },
  },
}

const webpageWithoutPhoto = {
  id: 505,
  media: {
    className: "MessageMediaWebPage",
    webpage: {},
  },
}

describe("downloadMessageMedia", () => {
  let client: { downloadMedia: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    uploadTelegramMediaMock.mockReset()
    uploadTelegramThumbMock.mockReset()
    client = { downloadMedia: vi.fn() }
  })

  it("AC-4: a photo returns the uploader's URL with thumbUrl equal to the body URL", async () => {
    uploadTelegramMediaMock.mockResolvedValue({
      url: cdn("telegram/design_digest/503.jpg"),
      type: "photo",
      thumbUrl: cdn("telegram/design_digest/503.jpg"),
    })

    const result = await downloadMessageMedia(client, photoMessage, CHANNEL)

    expect(result).toEqual({
      url: cdn("telegram/design_digest/503.jpg"),
      type: "photo",
      thumbUrl: cdn("telegram/design_digest/503.jpg"),
      skipped: false,
    })
    expect(result.thumbUrl).toBe(result.url)
    expect(uploadTelegramMedia).toHaveBeenCalledWith(client, photoMessage, CHANNEL)
  })

  it("AC-4: a document at or under 50MB returns the body URL and its thumbUrl", async () => {
    uploadTelegramMediaMock.mockResolvedValue({
      url: cdn("telegram/design_digest/502.mp4"),
      type: "video",
      thumbUrl: cdn("telegram/design_digest/502_thumb.jpg"),
    })

    const result = await downloadMessageMedia(client, videoWithThumbs, CHANNEL)

    expect(result).toEqual({
      url: cdn("telegram/design_digest/502.mp4"),
      type: "video",
      thumbUrl: cdn("telegram/design_digest/502_thumb.jpg"),
      skipped: false,
    })
    expect(uploadTelegramMedia).toHaveBeenCalledWith(client, videoWithThumbs, CHANNEL)
  })

  it("AC-4: a document larger than 50MB is marked not-mirrored, skips the body upload and still fetches the poster", async () => {
    uploadTelegramThumbMock.mockResolvedValue(
      cdn("telegram/design_digest/502_thumb.jpg")
    )

    const result = await downloadMessageMedia(client, oversizedDocument, CHANNEL)

    // A marker, not null: the renderer draws its "Media not mirrored · Open in
    // Telegram" row from it, and the raw URL carries the post path (RAD-359).
    expect(result.url).toBe(`tg://too-large/${CHANNEL}/${oversizedDocument.id}`)
    expect(result.skipped).toBe(true)
    expect(result.thumbUrl).toBe(cdn("telegram/design_digest/502_thumb.jpg"))
    expect(uploadTelegramMedia).not.toHaveBeenCalled()
    expect(uploadTelegramThumb).toHaveBeenCalledTimes(1)
    expect(uploadTelegramThumb).toHaveBeenCalledWith(
      client,
      oversizedDocument,
      CHANNEL
    )
  })

  it("AC-4: a message with no media is skipped with type null and thumbUrl null", async () => {
    const result = await downloadMessageMedia(
      client,
      { id: 506, media: null },
      CHANNEL
    )

    expect(result).toEqual({
      url: null,
      type: null,
      thumbUrl: null,
      skipped: true,
    })
    expect(uploadTelegramMedia).not.toHaveBeenCalled()
    expect(uploadTelegramThumb).not.toHaveBeenCalled()
  })

  it("AC-4: an unsupported media class is skipped without calling the uploader", async () => {
    const message = {
      id: 507,
      media: { className: "MessageMediaPoll", poll: {} },
    }

    const result = await downloadMessageMedia(client, message, CHANNEL)

    expect(result).toEqual({
      url: null,
      type: null,
      thumbUrl: null,
      skipped: true,
    })
    expect(uploadTelegramMedia).not.toHaveBeenCalled()
    expect(uploadTelegramThumb).not.toHaveBeenCalled()
  })

  it("AC-4: an uploader failure is skipped with type null and thumbUrl null", async () => {
    uploadTelegramMediaMock.mockRejectedValue(new Error("upload failed"))

    const result = await downloadMessageMedia(client, photoMessage, CHANNEL)

    expect(result).toEqual({
      url: null,
      type: null,
      thumbUrl: null,
      skipped: true,
    })
  })

  it("AC-5: a MessageMediaWebPage with a photo is uploaded via uploadTelegramMedia", async () => {
    uploadTelegramMediaMock.mockResolvedValue({
      url: cdn("telegram/design_digest/504.jpg"),
      type: "photo",
      thumbUrl: cdn("telegram/design_digest/504.jpg"),
    })

    const result = await downloadMessageMedia(client, webpageWithPhoto, CHANNEL)

    expect(result).toEqual({
      url: cdn("telegram/design_digest/504.jpg"),
      type: "photo",
      thumbUrl: cdn("telegram/design_digest/504.jpg"),
      skipped: false,
    })
    expect(uploadTelegramMedia).toHaveBeenCalledWith(
      client,
      webpageWithPhoto,
      CHANNEL
    )
  })

  it("AC-5: a MessageMediaWebPage without a photo is skipped without calling the uploader", async () => {
    const result = await downloadMessageMedia(
      client,
      webpageWithoutPhoto,
      CHANNEL
    )

    expect(result).toEqual({
      url: null,
      type: null,
      thumbUrl: null,
      skipped: true,
    })
    expect(uploadTelegramMedia).not.toHaveBeenCalled()
    expect(uploadTelegramThumb).not.toHaveBeenCalled()
  })
})
