import { PrismaClient } from "@prisma/client"
import { db as sharedDb } from "@/lib/db"

/**
 * Cross-process GramJS session lock.
 *
 * Only one worker process may hold an open GramJS client for a given Telegram
 * session string — two clients make Telegram invalidate the auth key forever
 * (AUTH_KEY_DUPLICATED). The original implementation acquired a session-scoped
 * `pg_try_advisory_lock` through the shared Prisma pool and trusted it for the
 * process lifetime. Two ways that failed in production (2026-09-14), and a
 * third found later:
 *
 *   1. The pooled connection holding the lock was released, silently dropping
 *      the lock while the worker kept its GramJS client — a second container
 *      then acquired the lock and connected too.
 *   2. After a failure, a re-acquire landed on a different pooled connection,
 *      where `pg_try_advisory_lock` reported the lock as held by "someone else"
 *      — which was the same process. Setup was skipped and returned success.
 *   3. (2026-10-25) Even pinned to one connection, Prisma's pool replaced it
 *      after `max_idle_connection_lifetime` (default 300 s) although the
 *      keepalive queried it every 15 s, and the session lock died with the old
 *      backend — so the lock was lost every ~5 minutes. Reproduced on the dev DB: backend replaced at 308 s by
 *      default, held for 928 s with `max_idle_connection_lifetime=0`.
 *
 * This module fixes all three: the lock lives on a dedicated single-connection
 * PrismaClient (`connection_limit=1`, `max_idle_connection_lifetime=0`), so it
 * cannot be silently dropped by pool churn or idle recycling; ownership is
 * re-verified on a keepalive cadence against `pg_locks`; and a definitive loss
 * fires `onLost` once so the caller can drop its GramJS client before anyone
 * else connects.
 *
 * Failure semantics callers rely on:
 *   - acquire() returns false ONLY when another session holds the lock;
 *     a database error is thrown (an unreachable DB is not "peer owns it").
 *   - verify() returns false only on a definitive loss. DB errors, and the
 *     both-connections-unreachable case, return true (never a false "lost").
 *   - release() and stop() never throw.
 */

export const GRAMJS_LOCK_KEY = "radaric-gramjs-worker"

interface LockDbClient {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
  $executeRawUnsafe?(query: string, ...values: unknown[]): Promise<unknown>
  $disconnect(): Promise<void>
}

export interface GramJSLockOptions {
  /** Test seam: build the dedicated lock client. Defaults to a pinned PrismaClient. */
  createClient?: () => LockDbClient
  /** Test seam: read-only fallback used when the pinned connection is unreachable. */
  sharedDb?: LockDbClient
  /** Fired at most once per acquisition when ownership is definitively lost. */
  onLost?: () => void
  /** Keepalive cadence; also the settle granularity. */
  keepAliveMs?: number
  /** How long ownership must verify clean before acquire() reports success. */
  settleMs?: number
  /** Test seam: sleep implementation. */
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export interface GramJSLock {
  acquire(): Promise<boolean>
  verify(): Promise<boolean>
  release(): Promise<void>
  stop(): Promise<void>
  isOwned(): boolean
}

/**
 * Pin the pool to a single connection and disable idle-connection recycling
 * (Prisma replaced the connection after 300 s by default, even under a 15 s
 * keepalive, dropping the session lock with it); never duplicate either parameter. Falls back to the
 * raw URL for anything URL() refuses to parse — the query layer will surface
 * the real error.
 */
export function buildLockDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    url.searchParams.set("connection_limit", "1")
    url.searchParams.set("max_idle_connection_lifetime", "0")
    return url.toString()
  } catch {
    return raw
  }
}

/**
 * Transaction-mode poolers (Neon `-pooler`, Supabase `.pooler.`, or any URL
 * with `pgbouncer=true`) do not preserve session state between transactions, so
 * a session advisory lock is granted and dropped inside the same transaction —
 * it protects nothing. Callers should use a direct connection for the lock.
 */
export function looksPooled(raw: string | undefined): boolean {
  if (!raw) return false
  try {
    const url = new URL(raw)
    return url.hostname.includes("pooler") || url.searchParams.get("pgbouncer") === "true"
  } catch {
    return /pooler|pgbouncer=true/.test(raw)
  }
}

export function createGramJSLock(options: GramJSLockOptions = {}): GramJSLock {
  const keepAliveMs = options.keepAliveMs ?? 15_000
  const settleMs = options.settleMs ?? 30_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? ((message: string) => console.log(`[GramJS lock] ${message}`))

  let client: LockDbClient | null = null
  let owned = false
  let lostLatched = false
  let backendPid: number | null = null
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null

  function getClient(): LockDbClient {
    if (!client) {
      const databaseUrl = process.env.DATABASE_URL
      if (looksPooled(databaseUrl)) {
        log(
          "DATABASE_URL is a transaction-mode pooler — session advisory locks are void there. Use a direct connection for the worker."
        )
      }
      client = options.createClient
        ? options.createClient()
        : (new PrismaClient({
            datasourceUrl: buildLockDatabaseUrl(databaseUrl),
          }) as unknown as LockDbClient)
    }
    return client
  }

  function fallbackClient(): LockDbClient {
    return options.sharedDb ?? (sharedDb as unknown as LockDbClient)
  }

  function stopKeepAlive(): void {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
  }

  async function readBackendPid(dbc: LockDbClient): Promise<number | null> {
    try {
      const rows = await dbc.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() as pid`
      const pid = Number(rows[0]?.pid)
      return Number.isFinite(pid) ? pid : null
    } catch {
      return null
    }
  }

  async function applyStatementTimeout(dbc: LockDbClient): Promise<void> {
    try {
      // Best effort: a wedged query on the only connection would otherwise
      // silently stop the very detector that guards the lock.
      if (dbc.$executeRawUnsafe) await dbc.$executeRawUnsafe("SET statement_timeout = 5000")
    } catch {
      // Not fatal — the server default applies.
    }
  }

  async function verify(): Promise<boolean> {
    if (!owned) return false
    try {
      const rows = await getClient().$queryRaw<Array<{ held: number }>>`
        SELECT count(*)::int as held FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND pid = pg_backend_pid()
          AND objid::bigint = (hashtext(${GRAMJS_LOCK_KEY})::bigint & 4294967295)
          AND classid::bigint = ((hashtext(${GRAMJS_LOCK_KEY})::bigint >> 32) & 4294967295)
      `
      return Number(rows[0]?.held ?? 0) > 0
    } catch {
      // Pinned connection unreachable. Ask the shared client whether the
      // backend that took the lock still holds it. If neither answers, we
      // cannot prove a loss — never disconnect GramJS on an unproven loss.
      if (backendPid == null) return true
      try {
        const rows = await fallbackClient().$queryRaw<Array<{ held: number }>>`
          SELECT count(*)::int as held FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND objsubid = 1
            AND pid = ${backendPid}
            AND objid::bigint = (hashtext(${GRAMJS_LOCK_KEY})::bigint & 4294967295)
            AND classid::bigint = ((hashtext(${GRAMJS_LOCK_KEY})::bigint >> 32) & 4294967295)
        `
        return Number(rows[0]?.held ?? 0) > 0
      } catch {
        return true
      }
    }
  }

  function startKeepAlive(): void {
    if (keepAliveTimer) return
    keepAliveTimer = setInterval(() => {
      void (async () => {
        if (!owned) return
        const held = await verify()
        // `owned` again: a release() that ran while this tick's query was in
        // flight already gave the lock up on purpose. Reporting that as a loss
        // put a scary "Session lock lost" line in every graceful shutdown.
        if (!held && owned) {
          owned = false
          stopKeepAlive()
          if (!lostLatched) {
            lostLatched = true
            log("Session lock lost — notifying owner")
            options.onLost?.()
          }
        }
      })()
    }, keepAliveMs)
    keepAliveTimer.unref?.()
  }

  async function acquire(): Promise<boolean> {
    if (owned) return true

    const dbc = getClient()
    // DB errors propagate: callers must treat them as transient, never as
    // "a peer holds the lock" (that would retry on the wrong cadence forever).
    const rows = await dbc.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(hashtext(${GRAMJS_LOCK_KEY})) as acquired
    `
    if (rows[0]?.acquired !== true) return false

    owned = true
    lostLatched = false
    backendPid = await readBackendPid(dbc)
    if (backendPid == null) {
      // Without the backend pid the fallback probe can never prove a loss, and
      // a dead session would read as "still owned" forever. Refuse the lock.
      await release()
      throw new Error("Cannot read the session's backend pid — releasing the lock instead of holding an unverifiable one")
    }
    await applyStatementTimeout(dbc)

    // Settle grace: a fresh lock can appear free the instant the previous
    // holder's DB session dies while its GramJS socket is still open. Hold and
    // re-verify for a couple of keepalive ticks before anyone connects.
    if (settleMs > 0) {
      const ticks = Math.max(1, Math.ceil(settleMs / keepAliveMs))
      for (let tick = 0; tick < ticks; tick++) {
        await sleep(keepAliveMs)
        if (!(await verify())) {
          log("Lock did not survive the settle window — releasing")
          await release()
          return false
        }
      }
    }

    startKeepAlive()
    return true
  }

  async function release(): Promise<void> {
    stopKeepAlive()
    if (!owned) return
    owned = false
    try {
      await getClient().$queryRaw`
        SELECT pg_advisory_unlock(hashtext(${GRAMJS_LOCK_KEY})) as released
      `
    } catch {
      // Session death releases it anyway; release() must never throw.
    }
  }

  async function stop(): Promise<void> {
    await release()
    if (client) {
      try {
        await client.$queryRaw`SELECT pg_advisory_unlock_all()`
      } catch {
        // Ignore.
      }
      try {
        await client.$disconnect()
      } catch {
        // Ignore.
      }
    }
  }

  return {
    acquire,
    verify,
    release,
    stop,
    isOwned: () => owned,
  }
}
