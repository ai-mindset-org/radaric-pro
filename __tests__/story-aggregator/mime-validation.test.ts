import { describe, it, expect } from "vitest"
import {
  validateMediaUpload,
  getMimeTypeFromExtension,
  DEFAULT_MAX_SIZE_BYTES,
  ALLOWED_MIME_TYPES,
  MIME_TO_EXTENSION,
} from "@/lib/story-aggregator/mime-validation"

// ---------------------------------------------------------------------------
// Constants used across tests
// ---------------------------------------------------------------------------

const ONE_BYTE = 1
const FIFTY_MB = 50 * 1024 * 1024 // 52_428_800 bytes — matches DEFAULT_MAX_SIZE_BYTES

// ---------------------------------------------------------------------------
// 1. validateMediaUpload — allowed MIME/extension pairs (spec section 11 / 4.1)
//    Allowlist: image/jpeg, image/png, image/gif, image/webp, video/mp4
// ---------------------------------------------------------------------------

describe("validateMediaUpload accepts allowed MIME/extension pairs", () => {
  it("validateMediaUpload accepts image/jpeg with .jpg extension", () => {
    const result = validateMediaUpload("image/jpeg", "photo.jpg", ONE_BYTE)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("validateMediaUpload accepts image/jpeg with .jpeg extension", () => {
    const result = validateMediaUpload("image/jpeg", "photo.jpeg", ONE_BYTE)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("validateMediaUpload accepts image/png with .png extension", () => {
    const result = validateMediaUpload("image/png", "screenshot.png", ONE_BYTE)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("validateMediaUpload accepts image/gif with .gif extension", () => {
    const result = validateMediaUpload("image/gif", "animation.gif", ONE_BYTE)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("validateMediaUpload accepts image/webp with .webp extension", () => {
    const result = validateMediaUpload("image/webp", "image.webp", ONE_BYTE)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("validateMediaUpload accepts video/mp4 with .mp4 extension", () => {
    const result = validateMediaUpload("video/mp4", "clip.mp4", ONE_BYTE)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. validateMediaUpload — rejection scenarios
// ---------------------------------------------------------------------------

describe("validateMediaUpload rejects disallowed inputs", () => {
  it("validateMediaUpload rejects unknown MIME types", () => {
    const result = validateMediaUpload("application/pdf", "document.pdf", ONE_BYTE)
    expect(result.valid).toBe(false)
    expect(result.reason).toBeDefined()
    expect(typeof result.reason).toBe("string")
  })

  it("validateMediaUpload rejects MIME/extension mismatch (e.g. image/jpeg + .png)", () => {
    const result = validateMediaUpload("image/jpeg", "photo.png", ONE_BYTE)
    expect(result.valid).toBe(false)
    expect(result.reason).toBeDefined()
    expect(typeof result.reason).toBe("string")
  })

  it("validateMediaUpload rejects empty filename", () => {
    const result = validateMediaUpload("image/jpeg", "", ONE_BYTE)
    expect(result.valid).toBe(false)
    expect(result.reason).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 3. validateMediaUpload — file size enforcement
// ---------------------------------------------------------------------------

describe("validateMediaUpload enforces file size limits", () => {
  it("validateMediaUpload rejects files exceeding max size", () => {
    const overLimit = FIFTY_MB + ONE_BYTE
    const result = validateMediaUpload("image/jpeg", "big.jpg", overLimit)
    expect(result.valid).toBe(false)
    expect(result.reason).toBeDefined()
  })

  it("validateMediaUpload accepts files at exactly max size", () => {
    const result = validateMediaUpload("image/jpeg", "exactly.jpg", FIFTY_MB)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("validateMediaUpload uses default max size when not specified", () => {
    // One byte over the 50 MB default — must be rejected without explicit maxSizeBytes arg
    const overDefaultLimit = DEFAULT_MAX_SIZE_BYTES + ONE_BYTE
    const result = validateMediaUpload("image/jpeg", "huge.jpg", overDefaultLimit)
    expect(result.valid).toBe(false)
    expect(result.reason).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. validateMediaUpload — case-insensitive extension matching
// ---------------------------------------------------------------------------

describe("validateMediaUpload is case-insensitive for extensions", () => {
  it("validateMediaUpload is case-insensitive for extensions", () => {
    const upper = validateMediaUpload("image/jpeg", "PHOTO.JPG", ONE_BYTE)
    expect(upper.valid).toBe(true)

    const mixed = validateMediaUpload("image/png", "Screenshot.PNG", ONE_BYTE)
    expect(mixed.valid).toBe(true)

    const mp4Upper = validateMediaUpload("video/mp4", "Clip.MP4", ONE_BYTE)
    expect(mp4Upper.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. getMimeTypeFromExtension
// ---------------------------------------------------------------------------

describe("getMimeTypeFromExtension", () => {
  it("getMimeTypeFromExtension returns correct MIME for known extensions", () => {
    expect(getMimeTypeFromExtension("photo.jpg")).toBe("image/jpeg")
    expect(getMimeTypeFromExtension("photo.jpeg")).toBe("image/jpeg")
    expect(getMimeTypeFromExtension("image.png")).toBe("image/png")
    expect(getMimeTypeFromExtension("animation.gif")).toBe("image/gif")
    expect(getMimeTypeFromExtension("picture.webp")).toBe("image/webp")
    expect(getMimeTypeFromExtension("video.mp4")).toBe("video/mp4")
  })

  it("getMimeTypeFromExtension returns null for unknown extensions", () => {
    expect(getMimeTypeFromExtension("file.pdf")).toBeNull()
    expect(getMimeTypeFromExtension("archive.zip")).toBeNull()
    expect(getMimeTypeFromExtension("document.docx")).toBeNull()
    expect(getMimeTypeFromExtension("noextension")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. Exported constants — shape and value checks
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("ALLOWED_MIME_TYPES contains exactly the 5 specified types", () => {
    expect(ALLOWED_MIME_TYPES).toContain("image/jpeg")
    expect(ALLOWED_MIME_TYPES).toContain("image/png")
    expect(ALLOWED_MIME_TYPES).toContain("image/gif")
    expect(ALLOWED_MIME_TYPES).toContain("image/webp")
    expect(ALLOWED_MIME_TYPES).toContain("video/mp4")
    expect(ALLOWED_MIME_TYPES).toHaveLength(5)
  })

  it("DEFAULT_MAX_SIZE_BYTES equals 50 MB", () => {
    expect(DEFAULT_MAX_SIZE_BYTES).toBe(FIFTY_MB)
  })

  it("MIME_TO_EXTENSION maps every allowed MIME type to at least one extension", () => {
    for (const mime of ALLOWED_MIME_TYPES) {
      expect(MIME_TO_EXTENSION[mime]).toBeDefined()
      expect(Array.isArray(MIME_TO_EXTENSION[mime])).toBe(true)
      expect(MIME_TO_EXTENSION[mime].length).toBeGreaterThan(0)
    }
  })
})
