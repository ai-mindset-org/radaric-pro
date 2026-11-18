/**
 * lib/comp-access — setComplimentaryAccess grant/extend/revoke logic.
 *
 * Covers: server-computed expiry from `days`, extend-from-max(now, existing),
 * revoke (days=null), validation (non-int / ≤0 / > cap), and not-found mapping
 * (missing user on grant, P2025 on update).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

import { db } from "@/lib/db"
import {
  setComplimentaryAccess,
  COMP_MAX_DAYS,
  CompUserNotFoundError,
  CompValidationError,
} from "@/lib/comp-access"

const NOW = new Date("2026-05-01T12:00:00Z")
const DAY_MS = 86_400_000

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(db.user.update).mockResolvedValue({} as never)
})

describe("setComplimentaryAccess — grant", () => {
  it("fresh grant sets expiry to now + N days (no existing grant)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({ complimentaryAccessUntil: null } as never)

    const until = await setComplimentaryAccess("u1", 30)

    expect(until).toEqual(new Date(NOW.getTime() + 30 * DAY_MS))
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { complimentaryAccessUntil: new Date(NOW.getTime() + 30 * DAY_MS) },
    })
  })

  it("extend adds to remaining time when the existing grant is still active (max(now, existing))", async () => {
    const existing = new Date(NOW.getTime() + 10 * DAY_MS) // 10 days left
    vi.mocked(db.user.findUnique).mockResolvedValue({ complimentaryAccessUntil: existing } as never)

    const until = await setComplimentaryAccess("u1", 30)

    // 10 remaining + 30 new = 40 days from now, NOT 30 (extend must not shorten)
    expect(until).toEqual(new Date(existing.getTime() + 30 * DAY_MS))
  })

  it("extend from an EXPIRED grant restarts from now (max clamps to now)", async () => {
    const expired = new Date(NOW.getTime() - 5 * DAY_MS)
    vi.mocked(db.user.findUnique).mockResolvedValue({ complimentaryAccessUntil: expired } as never)

    const until = await setComplimentaryAccess("u1", 7)

    expect(until).toEqual(new Date(NOW.getTime() + 7 * DAY_MS))
  })
})

describe("setComplimentaryAccess — revoke", () => {
  it("days=null clears the field and does not read existing", async () => {
    const until = await setComplimentaryAccess("u1", null)

    expect(until).toBeNull()
    expect(db.user.findUnique).not.toHaveBeenCalled()
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { complimentaryAccessUntil: null },
    })
  })
})

describe("setComplimentaryAccess — validation", () => {
  it.each([0, -5, 3.5, Number.NaN, COMP_MAX_DAYS + 1])(
    "rejects invalid days=%s with CompValidationError and never writes",
    async (bad) => {
      await expect(setComplimentaryAccess("u1", bad as number)).rejects.toBeInstanceOf(
        CompValidationError
      )
      expect(db.user.update).not.toHaveBeenCalled()
    }
  )

  it("accepts the max allowed days", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({ complimentaryAccessUntil: null } as never)
    const until = await setComplimentaryAccess("u1", COMP_MAX_DAYS)
    expect(until).toEqual(new Date(NOW.getTime() + COMP_MAX_DAYS * DAY_MS))
  })

  it("rejects an empty userId", async () => {
    await expect(setComplimentaryAccess("", 30)).rejects.toBeInstanceOf(CompValidationError)
  })
})

describe("setComplimentaryAccess — not found", () => {
  it("throws CompUserNotFoundError when the user does not exist (grant path)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(null as never)

    await expect(setComplimentaryAccess("ghost", 30)).rejects.toBeInstanceOf(
      CompUserNotFoundError
    )
    expect(db.user.update).not.toHaveBeenCalled()
  })

  it("maps a Prisma P2025 on update to CompUserNotFoundError (revoke path race)", async () => {
    vi.mocked(db.user.update).mockRejectedValue({ code: "P2025" } as never)

    await expect(setComplimentaryAccess("ghost", null)).rejects.toBeInstanceOf(
      CompUserNotFoundError
    )
  })
})
