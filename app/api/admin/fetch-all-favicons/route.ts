import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { fetchSourceFavicon } from "@/lib/feed-favicon"

// POST /api/admin/fetch-all-favicons — backfill favicons for existing sources.
// Query params:
//   ?mode=missing (default) — only sources without faviconUrl
//   ?mode=all                — re-fetch favicons for every source
// Telegram/Twitter and Parallel-monitor sources return null (keep monogram).
export async function POST(request: NextRequest) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { role } = authResult

  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const mode = new URL(request.url).searchParams.get("mode") || "missing"

  const sources = await db.feed.findMany({
    where: mode === "all" ? {} : { faviconUrl: null },
    select: { id: true, type: true, url: true, name: true },
  })

  if (sources.length === 0) {
    return NextResponse.json({ message: "No sources to process", total: 0 })
  }

  const results: { name: string; type: string; faviconUrl: string | null; error?: string }[] = []

  for (const source of sources) {
    try {
      const faviconUrl = await fetchSourceFavicon({ type: source.type, url: source.url })
      if (faviconUrl) {
        await db.feed.update({
          where: { id: source.id },
          data: { faviconUrl },
        })
      }
      results.push({ name: source.name, type: source.type, faviconUrl })
    } catch (err) {
      results.push({
        name: source.name,
        type: source.type,
        faviconUrl: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 1s delay between requests — match fetch-all-covers, be polite to hosts.
    await new Promise((r) => setTimeout(r, 1000))
  }

  const found = results.filter((r) => r.faviconUrl).length
  const missed = results.filter((r) => !r.faviconUrl && !r.error).length
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
