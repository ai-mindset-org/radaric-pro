/**
 * PATCH/DELETE /api/feedback/[id] — Individual feedback management
 *
 * Tests for:
 *   - PATCH: update feedbackType
 *   - PATCH: update comment
 *   - PATCH: validation (empty body rejected)
 *   - PATCH: ownership check (404)
 *   - PATCH: auth (401)
 *   - DELETE: successful deletion
 *   - DELETE: ownership check (404)
 *   - DELETE: auth (401)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    aIFeedback: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn().mockResolvedValue(null),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { PATCH, DELETE } from "@/app/api/feedback/[id]/route"

const MOCK_USER_ID = "user-test-123"
const MOCK_FEEDBACK_ID = "feedback-test-456"
const params = Promise.resolve({ id: MOCK_FEEDBACK_ID })

function setupAuth(userId = MOCK_USER_ID) {
  vi.mocked(requireAuth).mockResolvedValue({ userId, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupFeedback(overrides: Record<string, unknown> = {}) {
  vi.mocked(db.aIFeedback.findUnique).mockResolvedValue({
    id: MOCK_FEEDBACK_ID,
    userId: MOCK_USER_ID,
    feedbackType: "LIKE",
    commentText: "Original comment",
    ...overrides,
  } as any)
}

beforeEach(() => vi.clearAllMocks())

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------
describe("PATCH /api/feedback/[id]", () => {
  it("updates feedbackType", async () => {
    setupAuth()
    setupFeedback()
    vi.mocked(db.aIFeedback.update).mockResolvedValue({ id: MOCK_FEEDBACK_ID, feedbackType: "DISLIKE" } as any)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ feedbackType: "DISLIKE" }),
    })
    const res = await PATCH(req, { params })

    expect(res.status).toBe(200)
    expect(db.aIFeedback.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ feedbackType: "DISLIKE" }),
      })
    )
  })

  it("updates comment text", async () => {
    setupAuth()
    setupFeedback()
    vi.mocked(db.aIFeedback.update).mockResolvedValue({ id: MOCK_FEEDBACK_ID, commentText: "Updated" } as any)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ comment: "Updated" }),
    })
    const res = await PATCH(req, { params })

    expect(res.status).toBe(200)
    expect(db.aIFeedback.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ commentText: "Updated" }),
      })
    )
  })

  it("returns 400 for empty body (at least one field required)", async () => {
    setupAuth()
    setupFeedback()

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    })
    const res = await PATCH(req, { params })

    expect(res.status).toBe(400)
  })

  it("returns 404 when feedback belongs to another user", async () => {
    setupAuth()
    vi.mocked(db.aIFeedback.findUnique).mockResolvedValue({
      id: MOCK_FEEDBACK_ID,
      userId: "other-user",
    } as any)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ feedbackType: "DISLIKE" }),
    })
    const res = await PATCH(req, { params })

    expect(res.status).toBe(404)
  })

  it("returns 401 when not authenticated", async () => {
    const { NextResponse } = await import("next/server")
    vi.mocked(requireAuth).mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    vi.mocked(isErrorResponse).mockReturnValue(true)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ feedbackType: "LIKE" }),
    })
    const res = await PATCH(req, { params })

    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
describe("DELETE /api/feedback/[id]", () => {
  it("deletes feedback successfully", async () => {
    setupAuth()
    setupFeedback()
    vi.mocked(db.aIFeedback.delete).mockResolvedValue({} as any)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, { method: "DELETE" })
    const res = await DELETE(req, { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(db.aIFeedback.delete).toHaveBeenCalledWith({ where: { id: MOCK_FEEDBACK_ID } })
  })

  it("returns 404 when feedback belongs to another user", async () => {
    setupAuth()
    vi.mocked(db.aIFeedback.findUnique).mockResolvedValue({
      id: MOCK_FEEDBACK_ID,
      userId: "other-user",
    } as any)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, { method: "DELETE" })
    const res = await DELETE(req, { params })

    expect(res.status).toBe(404)
  })

  it("returns 404 when feedback not found", async () => {
    setupAuth()
    vi.mocked(db.aIFeedback.findUnique).mockResolvedValue(null)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, { method: "DELETE" })
    const res = await DELETE(req, { params })

    expect(res.status).toBe(404)
  })

  it("returns 401 when not authenticated", async () => {
    const { NextResponse } = await import("next/server")
    vi.mocked(requireAuth).mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    vi.mocked(isErrorResponse).mockReturnValue(true)

    const req = new NextRequest(`http://localhost/api/feedback/${MOCK_FEEDBACK_ID}`, { method: "DELETE" })
    const res = await DELETE(req, { params })

    expect(res.status).toBe(401)
  })
})
