// @vitest-environment node

/**
 * RAD-359 (mirror layer) — lib/blob-storage.ts
 *
 * Contracts covered:
 *   AC-1 — audio documents: type "audio", `.ogg`/`.mp3`/`.m4a`/`.wav` keys + content types
 *   AC-2 — document extension/content-type table; DocumentAttributeFilename wins
 *   AC-3 — poster (`_thumb.jpg`) second upload returned as `thumbUrl`
 *   EC-1 — uploadTelegramThumb on a photo message returns null, no upload
 *   ERR-1 — uploadTelegramThumb never throws; a failed poster never sinks the body upload
 *
 * The S3 boundary is mocked (every PutObjectCommand/DeleteObjectCommand input is
 * captured) and the Telegram client is a bare `{ downloadMedia }` double. The
 * module reads R2_* env vars lazily, so they are set per test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { putInputs, deleteInputs, headInputs, storedKeys, sendMock } = vi.hoisted(() => ({
  putInputs: [] as Array<Record<string, unknown>>,
  deleteInputs: [] as Array<Record<string, unknown>>,
  headInputs: [] as Array<Record<string, unknown>>,
  /** Keys a HeadObjectCommand finds in the bucket; every other key is a 404. */
  storedKeys: new Set<string>(),
  sendMock: vi.fn<(command?: unknown) => Promise<unknown>>(async () => ({})),
}))

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
      putInputs.push(input)
    }
  }
  class DeleteObjectCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
      deleteInputs.push(input)
    }
  }
  class HeadObjectCommand {
    input: Record<string, unknown>
    isHead = true
    constructor(input: Record<string, unknown>) {
      this.input = input
      headInputs.push(input)
    }
  }
  class S3Client {
    send = sendMock
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand }
})

import {
  createdByCaller,
  r2ObjectState,
  uploadTelegramMedia,
  uploadTelegramThumb,
} from "@/lib/blob-storage"

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const R2_PUBLIC_URL = "https://cdn.example.com"
const CHANNEL = "design_digest"

const publicUrl = (key: string) => `${R2_PUBLIC_URL}/${key}`

type FakeClient = { downloadMedia: ReturnType<typeof vi.fn> }

/** Cast the bare double to whatever client type the uploader expects. */
const asClient = (client: FakeClient) =>
  client as unknown as Parameters<typeof uploadTelegramMedia>[0]

/**
 * Bare Telegram client double.
 * `downloadMedia(media)` (no thumb) resolves the body buffer;
 * `downloadMedia(media, { thumb })` resolves `thumbResult`.
 */
function makeFakeClient(
  body: Buffer | null,
  thumbResult: unknown = Buffer.alloc(4096, 1)
): FakeClient {
  return {
    downloadMedia: vi.fn(
      async (_media: unknown, options?: Record<string, unknown>) => {
        if (options && Object.prototype.hasOwnProperty.call(options, "thumb")) {
          return thumbResult
        }
        return body
      }
    ),
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const voiceMessage = {
  id: 501,
  media: {
    className: "MessageMediaDocument",
    document: {
      size: 12_000,
      mimeType: "audio/ogg",
      attributes: [{ className: "DocumentAttributeAudio", voice: true }],
    },
  },
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

const filenameDoc = {
  id: 601,
  media: {
    className: "MessageMediaDocument",
    document: {
      size: 4_000,
      mimeType: "application/octet-stream",
      attributes: [
        { className: "DocumentAttributeFilename", fileName: "report.PDF" },
      ],
    },
  },
}

function documentWithMime(mimeType: string) {
  return {
    id: 700,
    media: {
      className: "MessageMediaDocument",
      document: { size: 2_000, mimeType, attributes: [] },
    },
  }
}

const photoMessage = {
  id: 503,
  media: { className: "MessageMediaPhoto", photo: {} },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.R2_ENDPOINT = "https://r2.example.com"
  process.env.R2_ACCESS_KEY_ID = "test-access-key"
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key"
  process.env.R2_BUCKET_NAME = "radaric-media"
  process.env.R2_PUBLIC_URL = R2_PUBLIC_URL

  putInputs.length = 0
  deleteInputs.length = 0
  headInputs.length = 0
  storedKeys.clear()
  sendMock.mockReset()
  sendMock.mockImplementation(async (command?: unknown) => {
    const head = command as { isHead?: boolean; input?: { Key?: string } } | undefined
    if (head?.isHead && !storedKeys.has(String(head.input?.Key))) {
      throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })
    }
    return {}
  })
})

describe("uploadTelegramMedia — audio documents (AC-1)", () => {
  it("AC-1: a voice audio/ogg document returns type audio and uploads to .ogg with ContentType audio/ogg", async () => {
    const client = makeFakeClient(Buffer.alloc(12_000, 1))

    const result = await uploadTelegramMedia(asClient(client), voiceMessage, CHANNEL)

    expect(result.type).toBe("audio")
    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/501.ogg`))
    expect(result.thumbUrl).toBeNull()

    expect(putInputs).toHaveLength(1)
    expect(putInputs[0].Key).toBe(`telegram/${CHANNEL}/501.ogg`)
    expect(putInputs[0].ContentType).toBe("audio/ogg")
    expect((putInputs[0].Body as Buffer).length).toBe(12_000)
  })

  it.each([
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/x-wav", "wav"],
  ])(
    "AC-1: an audio document with mimeType %s resolves to .%s and type audio",
    async (mimeType, ext) => {
      const message = {
        id: 501,
        media: {
          className: "MessageMediaDocument",
          document: {
            size: 12_000,
            mimeType,
            attributes: [{ className: "DocumentAttributeAudio", voice: true }],
          },
        },
      }
      const client = makeFakeClient(Buffer.alloc(12_000, 1))

      const result = await uploadTelegramMedia(asClient(client), message, CHANNEL)

      expect(result.type).toBe("audio")
      expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/501.${ext}`))
      expect(result.thumbUrl).toBeNull()

      expect(putInputs).toHaveLength(1)
      expect(putInputs[0].Key).toBe(`telegram/${CHANNEL}/501.${ext}`)
      expect(putInputs[0].ContentType).toBe(mimeType)
    }
  )
})

describe("uploadTelegramMedia — document extension/content-type table (AC-2)", () => {
  it("AC-2: a DocumentAttributeFilename extension wins (report.PDF → .pdf, application/pdf)", async () => {
    const client = makeFakeClient(Buffer.alloc(4_000, 1))

    const result = await uploadTelegramMedia(asClient(client), filenameDoc, CHANNEL)

    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/601.pdf`))
    expect(result.thumbUrl).toBeNull()

    expect(putInputs).toHaveLength(1)
    expect(putInputs[0].Key).toBe(`telegram/${CHANNEL}/601.pdf`)
    expect(putInputs[0].ContentType).toBe("application/pdf")
  })

  it.each([
    ["video/mp4", "mp4", "video/mp4"],
    ["video/webm", "webm", "video/webm"],
    ["video/quicktime", "mov", "video/quicktime"],
    ["image/webp", "webp", "image/webp"],
    ["application/x-tgsticker", "tgs", "application/x-tgsticker"],
    ["application/pdf", "pdf", "application/pdf"],
  ])(
    "AC-2: a document with mimeType %s resolves to .%s with ContentType %s",
    async (mimeType, ext, contentType) => {
      const message = documentWithMime(mimeType)
      const client = makeFakeClient(Buffer.alloc(2_000, 1))

      const result = await uploadTelegramMedia(asClient(client), message, CHANNEL)

      expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/700.${ext}`))
      expect(result.thumbUrl).toBeNull()

      expect(putInputs).toHaveLength(1)
      expect(putInputs[0].Key).toBe(`telegram/${CHANNEL}/700.${ext}`)
      expect(putInputs[0].ContentType).toBe(contentType)
    }
  )

  it("AC-2: an unknown mimeType with no filename falls back to .bin and application/octet-stream", async () => {
    const message = documentWithMime("application/x-radaric-unknown")
    const client = makeFakeClient(Buffer.alloc(2_000, 1))

    const result = await uploadTelegramMedia(asClient(client), message, CHANNEL)

    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/700.bin`))
    expect(result.thumbUrl).toBeNull()

    expect(putInputs).toHaveLength(1)
    expect(putInputs[0].Key).toBe(`telegram/${CHANNEL}/700.bin`)
    expect(putInputs[0].ContentType).toBe("application/octet-stream")
  })
})

describe("uploadTelegramMedia — poster upload (AC-3)", () => {
  it("AC-3: a document with thumbs gets a second upload to _thumb.jpg returned as thumbUrl", async () => {
    const client = makeFakeClient(Buffer.alloc(30_000, 1), Buffer.alloc(4096, 1))

    const result = await uploadTelegramMedia(asClient(client), videoWithThumbs, CHANNEL)

    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/502.mp4`))
    expect(result.type).toBe("video")
    expect(result.thumbUrl).toBe(publicUrl(`telegram/${CHANNEL}/502_thumb.jpg`))

    expect(putInputs).toHaveLength(2)
    expect(putInputs[1].Key).toBe(`telegram/${CHANNEL}/502_thumb.jpg`)
    expect(putInputs[1].ContentType).toBe("image/jpeg")
    expect((putInputs[1].Body as Buffer).length).toBe(4096)
    expect(deleteInputs).toHaveLength(0)

    // Second download carries a `thumb` option; the body one does not.
    expect(client.downloadMedia).toHaveBeenCalledTimes(2)
    expect(
      Object.prototype.hasOwnProperty.call(
        client.downloadMedia.mock.calls[0][1] ?? {},
        "thumb"
      )
    ).toBe(false)
    expect(client.downloadMedia.mock.calls[1][1]).toHaveProperty("thumb")
  })

  it("AC-3: a thumb buffer shorter than 2048 bytes yields thumbUrl null while the body URL is returned", async () => {
    const client = makeFakeClient(Buffer.alloc(30_000, 1), Buffer.alloc(1024, 1))

    const result = await uploadTelegramMedia(asClient(client), videoWithThumbs, CHANNEL)

    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/502.mp4`))
    expect(result.thumbUrl).toBeNull()

    expect(putInputs).toHaveLength(1)
    expect(putInputs[0].Key).toBe(`telegram/${CHANNEL}/502.mp4`)
  })

  it("AC-3: a non-Buffer thumb download yields thumbUrl null while the body URL is returned", async () => {
    const client = makeFakeClient(Buffer.alloc(30_000, 1), null)

    const result = await uploadTelegramMedia(asClient(client), videoWithThumbs, CHANNEL)

    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/502.mp4`))
    expect(result.thumbUrl).toBeNull()

    expect(putInputs).toHaveLength(1)
    expect(putInputs[0].Key).toBe(`telegram/${CHANNEL}/502.mp4`)
  })
})

describe("uploadTelegramThumb (EC-1)", () => {
  it("EC-1: a photo message returns null and performs no upload", async () => {
    const client = makeFakeClient(Buffer.alloc(1024, 1))

    const result = await uploadTelegramThumb(asClient(client), photoMessage, CHANNEL)

    expect(result).toBeNull()
    expect(client.downloadMedia).not.toHaveBeenCalled()
    expect(putInputs).toHaveLength(0)
  })
})

describe("uploadTelegramThumb — never throws (ERR-1)", () => {
  it("ERR-1: returns null when downloadMedia rejects", async () => {
    const client: FakeClient = {
      downloadMedia: vi.fn(async () => {
        throw new Error("download failed")
      }),
    }

    const result = await uploadTelegramThumb(asClient(client), videoWithThumbs, CHANNEL)

    expect(result).toBeNull()
  })

  it("ERR-1: returns null when downloadMedia resolves a non-Buffer", async () => {
    const client: FakeClient = {
      downloadMedia: vi.fn(async () => "not a buffer"),
    }

    const result = await uploadTelegramThumb(asClient(client), videoWithThumbs, CHANNEL)

    expect(result).toBeNull()
  })

  it("ERR-1: returns null when the R2 upload rejects", async () => {
    sendMock.mockRejectedValue(new Error("R2 unavailable"))
    const client = makeFakeClient(Buffer.alloc(1024, 1), Buffer.alloc(4096, 1))

    const result = await uploadTelegramThumb(asClient(client), videoWithThumbs, CHANNEL)

    expect(result).toBeNull()
  })

  it("ERR-1: a rejected thumb download still lets uploadTelegramMedia return the body URL with thumbUrl null", async () => {
    const client: FakeClient = {
      downloadMedia: vi.fn(async (_media: unknown, options?: Record<string, unknown>) => {
        if (options && Object.prototype.hasOwnProperty.call(options, "thumb")) {
          throw new Error("thumb download failed")
        }
        return Buffer.alloc(30_000, 1)
      }),
    }

    const result = await uploadTelegramMedia(asClient(client), videoWithThumbs, CHANNEL)

    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/502.mp4`))
    expect(result.thumbUrl).toBeNull()
  })
})

describe("uploadTelegramMedia — an already-mirrored message is not downloaded again (RAD-359 review)", () => {
  it("returns the stored body and poster URLs without touching Telegram when both keys exist", async () => {
    storedKeys.add(`telegram/${CHANNEL}/502.mp4`)
    storedKeys.add(`telegram/${CHANNEL}/502_thumb.jpg`)
    const client = makeFakeClient(Buffer.alloc(30_000, 1))

    const result = await uploadTelegramMedia(asClient(client), videoWithThumbs, CHANNEL)

    expect(result).toEqual({
      url: publicUrl(`telegram/${CHANNEL}/502.mp4`),
      type: "video",
      thumbUrl: publicUrl(`telegram/${CHANNEL}/502_thumb.jpg`),
    })
    expect(client.downloadMedia).not.toHaveBeenCalled()
    expect(putInputs).toHaveLength(0)
    expect(headInputs.map((input) => input.Key)).toEqual([
      `telegram/${CHANNEL}/502.mp4`,
      `telegram/${CHANNEL}/502_thumb.jpg`,
    ])
  })

  it("still mirrors a missing poster when only the body is stored", async () => {
    storedKeys.add(`telegram/${CHANNEL}/502.mp4`)
    const client = makeFakeClient(Buffer.alloc(30_000, 1))

    const result = await uploadTelegramMedia(asClient(client), videoWithThumbs, CHANNEL)

    expect(result.thumbUrl).toBe(publicUrl(`telegram/${CHANNEL}/502_thumb.jpg`))
    expect(putInputs.map((input) => input.Key)).toEqual([`telegram/${CHANNEL}/502_thumb.jpg`])
    expect(client.downloadMedia).toHaveBeenCalledTimes(1)
  })

  it("falls back to downloading when the existence check itself fails", async () => {
    sendMock.mockImplementation(async (command?: unknown) => {
      if ((command as { isHead?: boolean } | undefined)?.isHead) throw new Error("R2 403")
      return {}
    })
    const client = makeFakeClient(Buffer.alloc(12_000, 1))

    const result = await uploadTelegramMedia(asClient(client), voiceMessage, CHANNEL)

    expect(result.url).toBe(publicUrl(`telegram/${CHANNEL}/501.ogg`))
    expect(putInputs).toHaveLength(1)
  })
})

describe("uploadTelegramMedia — empty download (RAD-359 review)", () => {
  it("rejects a zero-byte body instead of storing it — a stored empty object would now be kept forever", async () => {
    const client = makeFakeClient(Buffer.alloc(0))

    await expect(uploadTelegramMedia(asClient(client), photoMessage, CHANNEL)).rejects.toThrow()
    expect(putInputs).toHaveLength(0)
  })
})

describe("uploadTelegramMedia — link-preview photo (RAD-359 review)", () => {
  it("downloads the preview's photo, never the preview's document GramJS would pick first", async () => {
    const photo = { className: "Photo", id: 1 }
    const message = {
      id: 504,
      media: {
        className: "MessageMediaWebPage",
        webpage: { className: "WebPage", photo, document: { className: "Document", id: 2 } },
      },
    }
    const client = makeFakeClient(Buffer.alloc(8_000, 1))

    const result = await uploadTelegramMedia(asClient(client), message, CHANNEL)

    expect(client.downloadMedia).toHaveBeenCalledTimes(1)
    expect(client.downloadMedia.mock.calls[0][0]).toBe(photo)
    expect(result).toEqual({
      url: publicUrl(`telegram/${CHANNEL}/504.jpg`),
      type: "photo",
      thumbUrl: publicUrl(`telegram/${CHANNEL}/504.jpg`),
    })
  })
})

describe("r2ObjectState — fail-closed three-state HEAD (RAD-368)", () => {
  const key = `telegram/${CHANNEL}/900.jpg`;

  it("a real 404 is absent, and only an absent key may be deleted afterwards", async () => {
    const state = await r2ObjectState(key);

    expect(state).toBe("absent");
    expect(createdByCaller(state)).toBe(true);
  });

  it("a HEAD timeout is unknown — the key must not be deleted", async () => {
    sendMock.mockRejectedValueOnce(new Error("HEAD timeout after 5000ms"));

    const state = await r2ObjectState(key);

    expect(state).toBe("unknown");
    expect(createdByCaller(state)).toBe(false);
  });

  it("a 403 is unknown — the key must not be deleted", async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } })
    );

    const state = await r2ObjectState(key);

    expect(state).toBe("unknown");
    expect(createdByCaller(state)).toBe(false);
  });

  it("an existing object is exists — the key must not be deleted", async () => {
    storedKeys.add(key);

    const state = await r2ObjectState(key);

    expect(state).toBe("exists");
    expect(createdByCaller(state)).toBe(false);
  });
});
