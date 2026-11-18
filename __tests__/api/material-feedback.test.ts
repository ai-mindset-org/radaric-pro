/**
 * POST /api/materials/[id]/feedback — Material feedback API
 *
 * Tests for like/dislike feedback on materials:
 *   - LIKE with comment
 *   - DISLIKE without comment
 *   - Upsert semantics (second call updates, doesn't create duplicate)
 *   - Auth required (401)
 *   - Material ownership check (404 for other user's material)
 *   - Comment length validation (max 500)
 *   - Invalid feedbackType (400)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ---------------------------------------------------------------------------
// Mock @/lib/db
// ---------------------------------------------------------------------------
const mockFindUnique = vi.fn()
const mockUpsert = vi.fn()

vi.mock("@/lib/db", () => ({
  db: {
    material: { findUnique: vi.fn() },
    aIFeedback: { upsert: vi.fn() },
  },
}))

// ---------------------------------------------------------------------------
// Mock @/lib/auth-utils
// ---------------------------------------------------------------------------
vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn().mockResolvedValue(null),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { POST } from "@/app/api/posts/[id]/feedback/route"

const MOCK_USER_ID = "user-test-123"
const MOCK_MATERIAL_ID = "material-test-456"
const MOCK_SOURCE_ID = "source-test-789"

function setupAuth(userId = MOCK_USER_ID) {
  vi.mocked(requireAuth).mockResolvedValue({ userId, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupMaterial(overrides: Record<string, unknown> = {}) {
  vi.mocked(db.material.findUnique).mockResolvedValue({
    id: MOCK_MATERIAL_ID,
    sourceId: MOCK_SOURCE_ID,
    feed: { userId: MOCK_USER_ID },
    ...overrides,
  } as any)
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/materials/${MOCK_MATERIAL_ID}/feedback`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: MOCK_MATERIAL_ID })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.aIFeedback.upsert).mockResolvedValue({
    id: "feedback-1",
    feedbackType: "LIKE",
    commentText: null,
    createdAt: new Date(),
  } as any)
})

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------
describe("POST /api/materials/[id]/feedback — happy paths", () => {
  it("creates LIKE feedback with comment", async () => {
    setupAuth()
    setupMaterial()

    const req = makeRequest({ feedbackType: "LIKE", comment: "Great analysis" })
    const res = await POST(req, { params })

    expect(res.status).toBe(200)
    expect(db.aIFeedback.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId_materialId: { userId: MOCK_USER_ID, materialId: MOCK_MATERIAL_ID },
        }),
        create: expect.objectContaining({
          feedbackType: "LIKE",
          commentText: "Great analysis",
        }),
        update: expect.objectContaining({
          feedbackType: "LIKE",
          commentText: "Great analysis",
        }),
      })
    )
  })

  it("creates DISLIKE feedback without comment", async () => {
    setupAuth()
    setupMaterial()

    const req = makeRequest({ feedbackType: "DISLIKE" })
    const res = await POST(req, { params })

    expect(res.status).toBe(200)
    expect(db.aIFeedback.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          feedbackType: "DISLIKE",
          commentText: null,
        }),
      })
    )
  })

  it("returns feedback data in response", async () => {
    setupAuth()
    setupMaterial()
    vi.mocked(db.aIFeedback.upsert).mockResolvedValue({
      id: "feedback-1",
      feedbackType: "LIKE",
      commentText: "Nice",
      createdAt: new Date("2026-03-13"),
    } as any)

    const req = makeRequest({ feedbackType: "LIKE", comment: "Nice" })
    const res = await POST(req, { params })
    const data = await res.json()

    expect(data.id).toBe("feedback-1")
    expect(data.feedbackType).toBe("LIKE")
    expect(data.commentText).toBe("Nice")
  })
})

// ---------------------------------------------------------------------------
// Auth & ownership
// ---------------------------------------------------------------------------
describe("POST /api/materials/[id]/feedback — auth & ownership", () => {
  it("returns 401 when not authenticated", async () => {
    const { NextResponse } = await import("next/server")
    vi.mocked(requireAuth).mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    vi.mocked(isErrorResponse).mockReturnValue(true)

    const req = makeRequest({ feedbackType: "LIKE" })
    const res = await POST(req, { params })

    expect(res.status).toBe(401)
  })

  it("returns 404 when material belongs to another user", async () => {
    setupAuth()
    vi.mocked(db.material.findUnique).mockResolvedValue(null)

    const req = makeRequest({ feedbackType: "LIKE" })
    const res = await POST(req, { params })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("POST /api/materials/[id]/feedback — validation", () => {
  it("returns 400 for invalid feedbackType", async () => {
    setupAuth()
    setupMaterial()

    const req = makeRequest({ feedbackType: "INVALID" })
    const res = await POST(req, { params })

    expect(res.status).toBe(400)
  })

  it("returns 400 when comment exceeds 500 chars", async () => {
    setupAuth()
    setupMaterial()

    const req = makeRequest({ feedbackType: "LIKE", comment: "x".repeat(501) })
    const res = await POST(req, { params })

    expect(res.status).toBe(400)
  })

  it("returns 400 when feedbackType is missing", async () => {
    setupAuth()
    setupMaterial()

    const req = makeRequest({ comment: "no type" })
    const res = await POST(req, { params })

    expect(res.status).toBe(400)
  })
})
