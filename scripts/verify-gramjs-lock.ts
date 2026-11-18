/**
 * Real-Postgres probe for the GramJS session lock (RAD-328).
 *
 * The lock's failure mode in production was a *runtime* property — a session
 * lock that survives pool churn, and a loss that is *detected* when its backend
 * dies so the client can be dropped before a peer connects. Mock-based unit
 * tests can pin the implementation, never that property. This script exercises
 * it against a real database.
 *
 *   INTEGRATION_DB_URL="postgres://…" npx tsx scripts/verify-gramjs-lock.ts [--minutes N]
 *
 * What it asserts, and what it does not:
 *   - mutual exclusion: while one session holds the lock, no other can take it;
 *   - handover: `$disconnect()` without unlock, and explicit `release()`, both
 *     free the lock for the next session;
 *   - detected loss: `pg_terminate_backend` on the holder's backend must be
 *     seen by the module (`verify()` false, `onLost` once) — the property that
 *     keeps a peer from connecting while our client is still alive;
 *   - durability over the hold window: ownership must not silently evaporate.
 *     On some managed Postgres with idle-backend recycling (measured), the
 *     backend is recycled ~5 min after connection establishment *regardless of
 *     query activity* — Prisma reconnects silently and the session lock is
 *     gone. The probe treats a *detected* rotation as a pass (detection is the
 *     property under test) and only fails on an undetected loss. On a database
 *     that does not recycle backends, the same run additionally proves
 *     continuous holding.
 *
 * Safety: refuses to run unless INTEGRATION_DB_URL is set — it never touches
 * the app's DATABASE_URL. Transaction-mode poolers are refused: session
 * advisory locks are void there. Prints only the hostname, never credentials.
 */

import { PrismaClient } from "@prisma/client"
import { createGramJSLock, buildLockDatabaseUrl, looksPooled, GRAMJS_LOCK_KEY } from "../lib/story-aggregator/gramjs-lock"

const url = process.env.INTEGRATION_DB_URL
if (!url) {
  console.error("INTEGRATION_DB_URL is not set. Refusing to run against DATABASE_URL.")
  process.exit(2)
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return "<unparseable>"
  }
}

const host = hostOf(url)
if (looksPooled(url)) {
  console.error(`Refusing: ${host} is a transaction-mode pooler — session advisory locks are void there.`)
  process.exit(2)
}

const minutesArg = process.argv.indexOf("--minutes")
const minutes = minutesArg >= 0 ? Number(process.argv[minutesArg + 1]) : 2
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error("--minutes must be a positive number")
  process.exit(2)
}

const rawClient = () => new PrismaClient({ datasourceUrl: buildLockDatabaseUrl(url) })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function tryRawLock(client: PrismaClient): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext(${GRAMJS_LOCK_KEY})) as acquired
  `
  return rows[0]?.acquired === true
}

async function unlockRaw(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT pg_advisory_unlock(hashtext(${GRAMJS_LOCK_KEY}))`
}

async function holderPid(client: PrismaClient): Promise<number | null> {
  const rows = await client.$queryRaw<Array<{ pid: number | null }>>`
    SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND objid::bigint = (hashtext(${GRAMJS_LOCK_KEY})::bigint & 4294967295)
      AND classid::bigint = ((hashtext(${GRAMJS_LOCK_KEY})::bigint >> 32) & 4294967295)
    LIMIT 1
  `
  return rows[0]?.pid ?? null
}

const failures: string[] = []
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  console.log(`GramJS lock probe against ${host} (hold ${minutes} min)`)
  const started = Date.now()

  // 1. A dropped session releases the lock — the mechanism the old guard missed.
  {
    const c = rawClient()
    check("scratch client acquires the lock", await tryRawLock(c))
    await c.$disconnect()
    const d = rawClient()
    const acquiredAfterDisconnect = await tryRawLock(d)
    check("$disconnect() without unlock releases the lock", acquiredAfterDisconnect)
    if (acquiredAfterDisconnect) await unlockRaw(d)
    await d.$disconnect()
  }

  // 2. The pinned lock client holds, and a second client cannot acquire.
  const lock = createGramJSLock({
    createClient: () => rawClient(),
    sharedDb: rawClient(),
    keepAliveMs: 15_000,
    settleMs: 0,
  })
  const observer = rawClient()

  check("lock.acquire()", await lock.acquire())
  {
    const contender = rawClient()
    check("second client refused while held", !(await tryRawLock(contender)))
    await contender.$disconnect()
  }
  check("verify() reports held", await lock.verify())

  let pidAtStart = await holderPid(observer)
  check("lock is registered in pg_locks", pidAtStart !== null, `pid=${pidAtStart}`)

  // 3. Hold across keepalive ticks; a platform session rotation must be DETECTED.
  const deadline = Date.now() + minutes * 60_000
  let tick = 0
  while (Date.now() < deadline) {
    await sleep(30_000)
    tick++

    const pidNow = await holderPid(observer)
    if (pidNow === null) {
      // The platform recycled the backend. Detection must follow within two
      // keepalive intervals; an undetected loss is the dangerous case.
      let detected = !lock.isOwned()
      for (let i = 0; i < 40 && !detected; i++) {
        await sleep(1_000)
        detected = !lock.isOwned()
      }
      check(`tick ${tick}: session rotation detected`, detected, "platform recycled the backend")
      if (detected) {
        const reacquired = await lock.acquire()
        check(`tick ${tick}: re-acquired after rotation`, reacquired)
        pidAtStart = await holderPid(observer)
      }
      continue
    }

    const sample = rawClient()
    const stillBlocked = !(await tryRawLock(sample))
    await sample.$disconnect()
    check(`tick ${tick}: lock still held`, stillBlocked)
    check(`tick ${tick}: same backend pid`, pidNow === pidAtStart, `pid=${pidNow}`)
    check(`tick ${tick}: verify() still true`, await lock.verify())
  }

  // 4. Explicit release hands the lock over.
  await lock.release()
  const afterRelease = rawClient()
  const acquiredAfterRelease = await tryRawLock(afterRelease)
  check("release() hands the lock over", acquiredAfterRelease)
  if (acquiredAfterRelease) await unlockRaw(afterRelease)
  await afterRelease.$disconnect()

  // 5. Kill the holder's backend: the module must see the loss and fire onLost.
  {
    let onLostCount = 0
    const killable = createGramJSLock({
      createClient: () => rawClient(),
      sharedDb: rawClient(),
      keepAliveMs: 1_000,
      settleMs: 0,
      onLost: () => {
        onLostCount++
      },
    })
    check("killable lock acquires", await killable.acquire())
    const killPid = await holderPid(observer)
    check("holder pid is visible", killPid !== null, `pid=${killPid}`)
    if (killPid !== null) {
      await observer.$queryRaw`SELECT pg_terminate_backend((${killPid})::int)`
      await sleep(2_500) // allow at least two keepalive intervals
      check("killed backend → verify() reports the loss", !(await killable.verify()))
      check("killed backend → onLost fired exactly once", onLostCount === 1, `count=${onLostCount}`)
    }
    await killable.stop()
  }

  await lock.stop()
  await observer.$disconnect()

  const secs = Math.round((Date.now() - started) / 1000)
  console.log(failures.length === 0 ? `\nALL CHECKS PASSED (${secs}s)` : `\n${failures.length} CHECK(S) FAILED (${secs}s)`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error("Probe crashed:", error instanceof Error ? error.message : error)
  process.exit(1)
})
