/**
 * GramJS worker session lock — RAD-328.
 *
 * The old guard (RAD-222) was a session-scoped advisory lock taken through the
 * shared Prisma pool. In production it was silently dropped when the pooled
 * connection went away, and after a failure a re-acquire on a different pooled
 * connection misread its own lock as "another process". These tests pin the
 * replacement's contract: a dedicated single-connection client, a keepalive
 * that verifies real ownership, and failure semantics that never masquerade.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  createGramJSLock,
  buildLockDatabaseUrl,
  looksPooled,
  GRAMJS_LOCK_KEY,
} from "@/lib/story-aggregator/gramjs-lock"

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $disconnect: vi.fn(),
  },
}))

type QueryCall = { sql: string; values: unknown[] }

function makeClient(handler: (sql: string, values: unknown[]) => unknown) {
  const calls: QueryCall[] = []
  return {
    calls,
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Array.from(strings).join("?")
      calls.push({ sql, values })
      return handler(sql, values)
    }),
    $executeRawUnsafe: vi.fn(async () => undefined),
    $disconnect: vi.fn(async () => undefined),
  }
}

/** Standard handler: every query succeeds; `held` controls the pg_locks probe. */
function okHandler(state: { held: number; acquired?: boolean; pid?: number }) {
  return (sql: string) => {
    if (sql.includes("pg_locks")) return [{ held: state.held }]
    if (sql.includes("pg_try_advisory_lock")) return [{ acquired: state.acquired ?? true }]
    if (sql.includes("pg_advisory_unlock_all")) return []
    if (sql.includes("pg_advisory_unlock")) return [{ released: true }]
    if (sql.includes("pg_backend_pid()")) return [{ pid: state.pid ?? 609 }]
    return []
  }
}

const instantSleep = () => vi.fn(async () => undefined)

describe("GramJS session lock (RAD-328)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("buildLockDatabaseUrl", () => {
    it("pins the pool to a single connection", () => {
      const url = buildLockDatabaseUrl("postgres://user:pass@db.internal:5432/railway")
      expect(url).toContain("connection_limit=1")
    })

    it("does not duplicate an existing connection_limit", () => {
      const url = buildLockDatabaseUrl("postgres://user:pass@db:5432/railway?connection_limit=7")
      expect(url?.match(/connection_limit/g)).toHaveLength(1)
      expect(url).toContain("connection_limit=1")
    })

    it("preserves other query parameters", () => {
      const url = buildLockDatabaseUrl("postgres://user:pass@db:5432/railway?sslmode=require&schema=public")
      expect(url).toContain("sslmode=require")
      expect(url).toContain("schema=public")
    })

    // Prisma's pool recycles an idle connection at 300 s by default, and the session advisory lock dies with it,
    // so the lock's client must disable recycling (max_idle_connection_lifetime=0).
    it("disables idle-connection recycling so the lock's backend is never replaced", () => {
      const url = buildLockDatabaseUrl("postgres://user:pass@db.internal:5432/railway")
      const params = new URL(url as string).searchParams
      expect(params.getAll("max_idle_connection_lifetime")).toEqual(["0"])
    })

    it("overrides an existing max_idle_connection_lifetime to 0 without duplicating it", () => {
      const url = buildLockDatabaseUrl("postgres://user:pass@db:5432/railway?max_idle_connection_lifetime=300")
      const params = new URL(url as string).searchParams
      expect(params.getAll("max_idle_connection_lifetime")).toEqual(["0"])
      expect(url?.match(/max_idle_connection_lifetime/g)).toHaveLength(1)
    })

    it("keeps connection_limit=1 and every other parameter alongside the idle-lifetime setting", () => {
      const url = buildLockDatabaseUrl(
        "postgres://user:pass@db:5432/railway?sslmode=require&schema=public&connection_limit=7&max_idle_connection_lifetime=300",
      )
      const params = new URL(url as string).searchParams
      expect(params.getAll("max_idle_connection_lifetime")).toEqual(["0"])
      expect(params.getAll("connection_limit")).toEqual(["1"])
      expect(params.get("sslmode")).toBe("require")
      expect(params.get("schema")).toBe("public")
    })

    it("leaves host, credentials and database untouched when adding the idle-lifetime setting", () => {
      const url = buildLockDatabaseUrl("postgres://user:pass@db.internal:5432/railway")
      const parsed = new URL(url as string)
      expect(parsed.searchParams.get("max_idle_connection_lifetime")).toBe("0")
      expect(parsed.username).toBe("user")
      expect(parsed.password).toBe("pass")
      expect(parsed.host).toBe("db.internal:5432")
      expect(parsed.pathname).toBe("/railway")
    })

    it("passes an unparseable URL through rather than losing it", () => {
      expect(buildLockDatabaseUrl("not a url")).toBe("not a url")
    })

    it("returns undefined when no URL is configured", () => {
      expect(buildLockDatabaseUrl(undefined)).toBeUndefined()
    })
  })

  describe("acquire", () => {
    it("creates the dedicated client lazily and reuses it", async () => {
      const createClient = vi.fn(() => makeClient(okHandler({ held: 1 })))
      const lock = createGramJSLock({ createClient, settleMs: 0 })
      expect(createClient).not.toHaveBeenCalled()
      expect(await lock.acquire()).toBe(true)
      await lock.release()
      expect(await lock.acquire()).toBe(true)
      expect(createClient).toHaveBeenCalledTimes(1)
    })

    it("returns false when another session holds the lock", async () => {
      const lock = createGramJSLock({
        createClient: () => makeClient(okHandler({ held: 1, acquired: false })),
        settleMs: 0,
      })
      expect(await lock.acquire()).toBe(false)
      expect(lock.isOwned()).toBe(false)
    })

    it("returns false for an empty result set (defensive)", async () => {
      const lock = createGramJSLock({
        createClient: () => makeClient(() => []),
        settleMs: 0,
      })
      expect(await lock.acquire()).toBe(false)
    })

    it("throws on a database error instead of claiming a peer holds the lock", async () => {
      const lock = createGramJSLock({
        createClient: () => makeClient(() => {
          throw new Error("connection refused")
        }),
        settleMs: 0,
      })
      await expect(lock.acquire()).rejects.toThrow("connection refused")
    })

    it("is idempotent — a re-acquire takes no second lock and starts no second keepalive", async () => {
      vi.useFakeTimers()
      try {
        const client = makeClient(okHandler({ held: 1 }))
        const lock = createGramJSLock({ createClient: () => client, keepAliveMs: 1_000, settleMs: 0 })
        await lock.acquire()
        const lockCallsAfterFirst = client.calls.filter((c) => c.sql.includes("pg_try_advisory_lock")).length
        expect(await lock.acquire()).toBe(true)
        expect(client.calls.filter((c) => c.sql.includes("pg_try_advisory_lock"))).toHaveLength(lockCallsAfterFirst)
        await vi.advanceTimersByTimeAsync(1_000)
        // Exactly one keepalive tick ran, not two.
        expect(client.calls.filter((c) => c.sql.includes("pg_locks"))).toHaveLength(1)
        await lock.release()
      } finally {
        vi.useRealTimers()
      }
    })

    it("applies a statement timeout on the pinned connection (best effort)", async () => {
      const client = makeClient(okHandler({ held: 1 }))
      const lock = createGramJSLock({ createClient: () => client, settleMs: 0 })
      await lock.acquire()
      expect(client.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("statement_timeout"))
      await lock.release()
    })
  })

  describe("settle grace", () => {
    it("holds through the settle window before reporting success", async () => {
      const state = { held: 1 }
      const client = makeClient(okHandler(state))
      const sleep = instantSleep()
      const lock = createGramJSLock({
        createClient: () => client,
        keepAliveMs: 1_000,
        settleMs: 2_000,
        sleep,
      })
      expect(await lock.acquire()).toBe(true)
      // Two ticks of verification before the lock is considered settled.
      expect(sleep).toHaveBeenCalledTimes(2)
      expect(client.calls.filter((c) => c.sql.includes("pg_locks"))).toHaveLength(2)
      await lock.release()
    })

    it("releases and reports false when ownership is gone by the end of the settle window", async () => {
      const state = { held: 1 }
      const client = makeClient(okHandler(state))
      const lock = createGramJSLock({
        createClient: () => client,
        keepAliveMs: 1_000,
        settleMs: 2_000,
        sleep: async () => {
          state.held = 0 // the previous holder's backend is gone for good
        },
      })
      expect(await lock.acquire()).toBe(false)
      expect(client.calls.some((c) => c.sql.includes("pg_advisory_unlock"))).toBe(true)
      expect(lock.isOwned()).toBe(false)
    })
  })

  describe("verify", () => {
    it("checks the exact advisory lock key on our own backend", async () => {
      const client = makeClient(okHandler({ held: 1 }))
      const lock = createGramJSLock({ createClient: () => client, settleMs: 0 })
      await lock.acquire()
      expect(await lock.verify()).toBe(true)
      const verifyCall = client.calls.find((c) => c.sql.includes("pg_locks"))
      expect(verifyCall).toBeDefined()
      const sql = verifyCall!.sql
      expect(sql).toContain("locktype = 'advisory'")
      expect(sql).toContain("granted")
      expect(sql).toContain("objsubid = 1")
      expect(sql).toContain("pg_backend_pid()")
      expect(sql).toContain("objid")
      expect(sql).toContain("classid")
      expect(sql).toContain("hashtext")
      expect(verifyCall!.values).toContain(GRAMJS_LOCK_KEY)
      expect(await lock.verify()).toBe(true)
      await lock.release()
    })

    it("returns false when the lock row is gone", async () => {
      const state = { held: 1 }
      const lock = createGramJSLock({ createClient: () => makeClient(okHandler(state)), settleMs: 0 })
      await lock.acquire()
      state.held = 0
      expect(await lock.verify()).toBe(false)
      await lock.release()
    })

    it("falls back to the shared client by recorded backend pid when the pinned one is unreachable", async () => {
      const state = { held: 1 }
      let pinnedBroken = false
      const pinned = makeClient((sql) => {
        if (pinnedBroken && sql.includes("pg_locks")) throw new Error("connection reset")
        return okHandler(state)(sql)
      })
      const shared = makeClient(okHandler(state))
      const lock = createGramJSLock({ createClient: () => pinned, sharedDb: shared, settleMs: 0 })
      await lock.acquire()
      pinnedBroken = true
      expect(await lock.verify()).toBe(true)
      const fallbackCall = shared.calls.find((c) => c.sql.includes("pg_locks"))
      expect(fallbackCall).toBeDefined()
      expect(fallbackCall!.values).toContain(609)
      await lock.release()
    })

    it("reports a definitive loss when the fallback no longer sees the backend holding the lock", async () => {
      const state = { held: 1 }
      let pinnedBroken = false
      const pinned = makeClient((sql) => {
        if (pinnedBroken && sql.includes("pg_locks")) throw new Error("connection reset")
        return okHandler(state)(sql)
      })
      const shared = makeClient(okHandler({ held: 0 }))
      const lock = createGramJSLock({ createClient: () => pinned, sharedDb: shared, settleMs: 0 })
      await lock.acquire()
      pinnedBroken = true
      expect(await lock.verify()).toBe(false)
      await lock.release()
    })

    it("does not declare a loss when both connections are unreachable", async () => {
      let broken = false
      const pinned = makeClient((sql) => {
        if (broken && sql.includes("pg_locks")) throw new Error("db down")
        return okHandler({ held: 1 })(sql)
      })
      const shared = makeClient(() => {
        throw new Error("db down")
      })
      const lock = createGramJSLock({ createClient: () => pinned, sharedDb: shared, settleMs: 0 })
      await lock.acquire()
      broken = true
      expect(await lock.verify()).toBe(true)
      await lock.release()
    })
  })

  describe("keepalive + onLost", () => {
    it("fires onLost exactly once when ownership is definitively lost", async () => {
      vi.useFakeTimers()
      try {
        const state = { held: 1 }
        const onLost = vi.fn()
        const client = makeClient(okHandler(state))
        const lock = createGramJSLock({
          createClient: () => client,
          onLost,
          keepAliveMs: 1_000,
          settleMs: 0,
        })
        await lock.acquire()
        state.held = 0
        await vi.advanceTimersByTimeAsync(1_000)
        expect(onLost).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(onLost).toHaveBeenCalledTimes(1)
        expect(lock.isOwned()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it("re-arms the latch after a successful re-acquire", async () => {
      vi.useFakeTimers()
      try {
        const state = { held: 1 }
        const onLost = vi.fn()
        const lock = createGramJSLock({
          createClient: () => makeClient(okHandler(state)),
          onLost,
          keepAliveMs: 1_000,
          settleMs: 0,
        })
        await lock.acquire()
        state.held = 0
        await vi.advanceTimersByTimeAsync(1_000)
        expect(onLost).toHaveBeenCalledTimes(1)

        state.held = 1
        expect(await lock.acquire()).toBe(true)
        state.held = 0
        await vi.advanceTimersByTimeAsync(1_000)
        expect(onLost).toHaveBeenCalledTimes(2)
        await lock.release()
      } finally {
        vi.useRealTimers()
      }
    })

    it("does not fire onLost on a database blip", async () => {
      vi.useFakeTimers()
      try {
        const onLost = vi.fn()
        let blip = false
        const pinned = makeClient((sql) => {
          if (blip && sql.includes("pg_locks")) throw new Error("connection reset")
          return okHandler({ held: 1 })(sql)
        })
        const lock = createGramJSLock({
          createClient: () => pinned,
          sharedDb: makeClient(() => {
            throw new Error("db down")
          }),
          onLost,
          keepAliveMs: 1_000,
          settleMs: 0,
        })
        await lock.acquire()
        blip = true
        await vi.advanceTimersByTimeAsync(3_000)
        expect(onLost).not.toHaveBeenCalled()
        await lock.release()
      } finally {
        vi.useRealTimers()
      }
    })

    it("does not report a loss when a release raced the keepalive tick", async () => {
      vi.useFakeTimers()
      try {
        let releaseQuery: (() => void) | null = null
        const onLost = vi.fn()
        const client = makeClient((sql) => {
          if (sql.includes("pg_locks")) {
            // Park the tick's verification until the release has happened.
            return new Promise((resolve) => {
              releaseQuery = () => resolve([{ held: 0 }])
            })
          }
          return okHandler({ held: 1 })(sql)
        })
        const lock = createGramJSLock({
          createClient: () => client,
          onLost,
          keepAliveMs: 1_000,
          settleMs: 0,
        })
        await lock.acquire()

        await vi.advanceTimersByTimeAsync(1_000) // tick starts, its verify() parks
        await lock.release() // gives the lock up on purpose
        releaseQuery!()
        await vi.advanceTimersByTimeAsync(0)

        expect(onLost).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it("stops the keepalive on release and on stop — no timer, no late onLost", async () => {
      vi.useFakeTimers()
      try {
        const onLost = vi.fn()
        const lock = createGramJSLock({
          createClient: () => makeClient(okHandler({ held: 0 })),
          onLost,
          keepAliveMs: 1_000,
          settleMs: 0,
        })
        await lock.acquire()
        await lock.release()
        expect(vi.getTimerCount()).toBe(0)

        await lock.acquire()
        await lock.stop()
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(onLost).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("release", () => {
    it("issues pg_advisory_unlock and is idempotent", async () => {
      const client = makeClient(okHandler({ held: 1 }))
      const lock = createGramJSLock({ createClient: () => client, settleMs: 0 })
      await lock.acquire()
      await lock.release()
      await lock.release()
      expect(client.calls.filter((c) => c.sql.includes("pg_advisory_unlock"))).toHaveLength(1)
      expect(lock.isOwned()).toBe(false)
    })

    it("is a no-op before acquire", async () => {
      const client = makeClient(okHandler({ held: 1 }))
      const lock = createGramJSLock({ createClient: () => client, settleMs: 0 })
      await lock.release()
      expect(client.calls).toHaveLength(0)
    })

    it("never throws when the database is gone", async () => {
      const lock = createGramJSLock({
        createClient: () => makeClient((sql) => {
          if (sql.includes("pg_advisory_unlock")) throw new Error("db down")
          return okHandler({ held: 1 })(sql)
        }),
        settleMs: 0,
      })
      await lock.acquire()
      await expect(lock.release()).resolves.toBeUndefined()
    })
  })

  describe("stop", () => {
    it("unlocks everything and disconnects the dedicated client", async () => {
      const client = makeClient(okHandler({ held: 1 }))
      const lock = createGramJSLock({ createClient: () => client, settleMs: 0 })
      await lock.acquire()
      await lock.stop()
      expect(client.calls.some((c) => c.sql.includes("pg_advisory_unlock_all"))).toBe(true)
      expect(client.$disconnect).toHaveBeenCalledTimes(1)
    })

    it("still disconnects when release throws", async () => {
      const client = makeClient((sql) => {
        if (sql.includes("pg_advisory_unlock")) throw new Error("db down")
        return okHandler({ held: 1 })(sql)
      })
      const lock = createGramJSLock({ createClient: () => client, settleMs: 0 })
      await lock.acquire()
      await expect(lock.stop()).resolves.toBeUndefined()
      expect(client.$disconnect).toHaveBeenCalledTimes(1)
    })
  })

  describe("error type", () => {
    it("keeps the stable lock key", () => {
      expect(GRAMJS_LOCK_KEY).toBe("radaric-gramjs-worker")
    })
  })

  describe("backend pid refusal", () => {
    it("releases and throws rather than holding a lock it cannot verify", async () => {
      const client = makeClient((sql) => {
        if (sql.includes("pg_try_advisory_lock")) return [{ acquired: true }]
        if (sql.includes("pg_backend_pid()")) return [] // pid read fails
        if (sql.includes("pg_advisory_unlock")) return [{ released: true }]
        return []
      })
      const lock = createGramJSLock({ createClient: () => client, settleMs: 0 })
      await expect(lock.acquire()).rejects.toThrow(/backend pid/)
      expect(client.calls.some((c) => c.sql.includes("pg_advisory_unlock"))).toBe(true)
      expect(lock.isOwned()).toBe(false)
    })
  })

  describe("pooled endpoints", () => {
    it("detects Neon, Supabase and pgbouncer-style poolers", () => {
      expect(looksPooled("postgres://user:pass@ep-x-pooler.c-2.us-east-1.aws.neon.tech/db")).toBe(true)
      expect(looksPooled("postgres://user:pass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")).toBe(true)
      expect(looksPooled("postgres://user:pass@db:5432/x?pgbouncer=true")).toBe(true)
      expect(looksPooled("postgres://user:pass@postgres.railway.internal:5432/railway")).toBe(false)
      expect(looksPooled(undefined)).toBe(false)
    })

    it("warns when DATABASE_URL looks pooled — the lock is void there", async () => {
      const previous = process.env.DATABASE_URL
      process.env.DATABASE_URL = "postgres://user:pass@ep-x-pooler.example.com/db"
      const logs: string[] = []
      try {
        const lock = createGramJSLock({
          createClient: () => makeClient(okHandler({ held: 1 })),
          settleMs: 0,
          log: (message) => logs.push(message),
        })
        await lock.acquire()
        expect(logs.some((message) => message.includes("pooler"))).toBe(true)
        await lock.release()
      } finally {
        process.env.DATABASE_URL = previous
      }
    })
  })
})
