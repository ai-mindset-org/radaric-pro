import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { fetchSourceCover } from "@/lib/feed-cover"

// POST /api/admin/fetch-all-covers — Scan sources and fetch covers
// Query params:
//   ?mode=all (default) — fetch covers for all sources without coverUrl + re-fetch all Telegram avatars
//   ?mode=missing — only sources without coverUrl
//   ?mode=telegram — only Telegram sources (force re-fetch avatars)
export async function POST(request: NextRequest) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { role } = authResult

  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const mode = new URL(request.url).searchParams.get("mode") || "all"

  // Build query based on mode
  let sources
  if (mode === "telegram") {
    // All Telegram sources — force re-fetch avatars
    sources = await db.feed.findMany({
      where: { type: "TELEGRAM" },
      select: { id: true, type: true, url: true, name: true },
    })
  } else if (mode === "missing") {
    // Only sources without covers
    sources = await db.feed.findMany({
      where: { coverUrl: null },
      select: { id: true, type: true, url: true, name: true },
    })
  } else {
    // "all": sources without covers + ALL Telegram sources (to replace manual covers with real avatars)
    sources = await db.feed.findMany({
      where: {
        OR: [
          { coverUrl: null },
          { type: "TELEGRAM" },
        ],
      },
      select: { id: true, type: true, url: true, name: true },
    })
  }

  if (sources.length === 0) {
    return NextResponse.json({ message: "No sources to process", total: 0 })
  }

  const results: { name: string; type: string; coverUrl: string | null; error?: string }[] = []

  for (const source of sources) {
    try {
      const coverUrl = await fetchSourceCover({ type: source.type, url: source.url })
      if (coverUrl) {
        await db.feed.update({
          where: { id: source.id },
          data: { coverUrl },
        })
      }
      results.push({ name: source.name, type: source.type, coverUrl })
    } catch (err) {
      results.push({
        name: source.name,
        type: source.type,
        coverUrl: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 1s delay between requests
    await new Promise((r) => setTimeout(r, 1000))
  }

  const found = results.filter((r) => r.coverUrl).length
  const missed = results.filter((r) => !r.coverUrl && !r.error).length
  const errors = results.filter((r) => r.error).length

  return NextResponse.json({
    mode,
    total: sources.length,
    found,
    missed,
    errors,
    results,
  })
}
