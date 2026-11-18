// @vitest-environment node

/**
 * POST /api/onboarding/parse-feeds — Server-side file size validation
 *
 * BUG-10: The route has no server-side 5MB file size check.
 * A direct API call can upload arbitrarily large files.
 *
 * Spec coverage:
 *   AC-1: A file > 5MB returns 400 with { error: "File too large. Max 5 MB." }
 *   AC-2: A file exactly at 5MB passes validation (no 400 returned)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB in bytes

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/feed-extraction", () => ({
  extractFeedsWithLLM: vi.fn(),
}))

vi.mock("@/lib/parsers/rss", () => ({
  detectRSSFeed: vi.fn(),
}))

vi.mock("@/lib/url-validation", () => ({
  isAllowedUrl: vi.fn(),
}))

import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { extractFeedsWithLLM } from "@/lib/feed-extraction"
import { isAllowedUrl } from "@/lib/url-validation"
import * as routeModule from "@/app/api/onboarding/parse-feeds/route"

const { POST } = routeModule

/**
 * Guard: all tests fail until the route exports FILE_SIZE_LIMIT.
 * This ensures AC-2 (boundary pass) also stays RED until the feature is implemented.
 */
function assertFileSizeLimitExported() {
  expect((routeModule as never as Record<string, unknown>).FILE_SIZE_LIMIT).toBe(5 * 1024 * 1024)
}

const USER_ID = "user-1"

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

/**
 * Create a real File object with the specified byte size.
 * Uses ArrayBuffer for exact sizing — zero-initialized, no actual content needed.
 */
function makeMockFile(sizeBytes: number, name = "feeds.txt"): File {
  return new File([new ArrayBuffer(sizeBytes)], name, { type: "text/plain" })
}

/**
 * Build a Request with FormData containing a file of the given size.
 */
function makeRequestWithFile(file: File): Request {
  const fd = new FormData()
  fd.append("file", file)
  return new Request("http://localhost/api/onboarding/parse-feeds", {
    method: "POST",
    body: fd,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isAllowedUrl).mockReturnValue(true)
  vi.mocked(extractFeedsWithLLM).mockResolvedValue([])
})

describe("POST /api/onboarding/parse-feeds — file size validation", () => {
  it("AC-1: returns 400 with correct error message when file exceeds 5MB", async () => {
    assertFileSizeLimitExported()
    setupAuth()

    const oversizedFile = makeMockFile(MAX_FILE_SIZE + 1) // 1 byte over limit
    const req = makeRequestWithFile(oversizedFile)

    const res = await POST(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: "File too large. Max 5 MB." })
  })

  it("AC-1: returns 400 for dramatically oversized file (50MB)", async () => {
    assertFileSizeLimitExported()
    setupAuth()

    const hugeFile = makeMockFile(50 * 1024 * 1024) // 50MB
    const req = makeRequestWithFile(hugeFile)

    const res = await POST(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("File too large. Max 5 MB.")
  })

  it("AC-2: does not return 400 when file is exactly 5MB (boundary passes validation)", async () => {
    assertFileSizeLimitExported()
    setupAuth()

    const exactFile = makeMockFile(MAX_FILE_SIZE) // exactly 5MB
    const req = makeRequestWithFile(exactFile)

    const res = await POST(req)

    // Must NOT be a 400 file-too-large rejection
    expect(res.status).not.toBe(400)
  })
})

// RAD-297: the route now also requires a verified email; these tests cover the
// file-size / subscription-gate shapes and stub the verification gate.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))
