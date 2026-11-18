import { requireAuth, isErrorResponse } from "@/lib/auth-utils"; import { db } from "@/lib/db"
export async function GET() { const a = await requireAuth(); if (isErrorResponse(a)) return a; const s = await db.userSettings.findUnique({ where: { userId: a.userId }, select: { onboardingState: true } }); return Response.json({ onboardingState: s?.onboardingState || null }) }
