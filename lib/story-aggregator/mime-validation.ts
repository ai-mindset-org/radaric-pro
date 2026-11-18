export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

export const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB

export const MIME_TO_EXTENSION: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"],
}

const EXTENSION_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
}

export function getMimeTypeFromExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf(".")
  if (lastDot === -1) return null
  const ext = filename.slice(lastDot).toLowerCase()
  return EXTENSION_TO_MIME[ext] ?? null
}

export function validateMediaUpload(
  mimeType: string,
  filename: string,
  sizeBytes: number,
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES
): { valid: true; reason?: undefined } | { valid: false; reason: string } {
  if (!filename) {
    return { valid: false, reason: "Filename is required" }
  }

  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return { valid: false, reason: `MIME type "${mimeType}" is not allowed` }
  }

  const expectedExtensions = MIME_TO_EXTENSION[mimeType]
  const lastDot = filename.lastIndexOf(".")
  if (lastDot === -1) {
    return { valid: false, reason: "Filename has no extension" }
  }
  const ext = filename.slice(lastDot).toLowerCase()
  if (!expectedExtensions.includes(ext)) {
    return {
      valid: false,
      reason: `Extension "${ext}" does not match MIME type "${mimeType}"`,
    }
  }

  if (sizeBytes > maxSizeBytes) {
    return {
      valid: false,
      reason: `File size ${sizeBytes} bytes exceeds maximum allowed size of ${maxSizeBytes} bytes`,
    }
  }

  return { valid: true }
}
