import { classifyGramJSSetupError, redactSecrets } from "./gramjs-errors"

/**
 * GramJS session lifecycle owner (RAD-328).
 *
 * The production outage was a *wiring* bug: four different call sites could
 * start GramJS (startup, the connection watchdog, `/telegram/reconnect`, and a
 * lock-loss signal), none of them owned the ordering, and a restarted setup
 * could silently skip the lock while the watchdog reported success. This
 * module is the single owner: one pass at a time, restarts queued rather than
 * dropped, and one observable session state that `/health` and
 * `/telegram/session-check` both read.
 *
 * State semantics:
 *   - `starting`     — not connected yet and no reason to believe the session
 *                      is bad: lock-waiting, connecting, warming up, retrying.
 *   - `active`       — a live GramJS client is serving the worker.
 *   - `invalid`      — Telegram answered AUTH_KEY_DUPLICATED/UNREGISTERED.
 *                      Only a re-auth (or an operator) can change this.
 *   - `unconfigured` — credentials or the inbox channel are not configured;
 *                      nothing to retry until configuration changes.
 *   - `unavailable`  — startup exhausted its transient retries; the worker runs
 *                      without Telegram until a restart or a re-auth.
 */

export type GramJSSessionState = "starting" | "active" | "invalid" | "unconfigured" | "unavailable"
export type GramJSSetupOutcome = "connected" | "unconfigured"

export interface GramJSLifecycleOptions {
  /** Runs one full setup attempt. Throws typed errors (see gramjs-errors). */
  setup: () => Promise<GramJSSetupOutcome>
  /** Drops the current client (and any session state) before a restart. */
  teardown: () => Promise<void>
  onStateChange?: (state: GramJSSessionState) => void
  /** Unrecoverable for this process — the worker asks Railway for a restart. */
  onFatal?: (reason: string) => void
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  /** Lock-wait backoff base/floor — must not be shorter than the lock's keepalive. */
  lockWaitMs?: number
  maxLockWaitMs?: number
  setupRetryDelayMs?: number
  maxTransientStartupAttempts?: number
  maxTransientRestartAttempts?: number
}

export interface GramJSLifecycle {
  /** Startup pass — no teardown (nothing is up yet). Never rejects. */
  start(): Promise<void>
  /**
   * The single restart funnel. Safe to call from the watchdog, the lock-loss
   * callback and `/telegram/reconnect`: if a pass is in flight the request is
   * replayed after it, never dropped.
   */
  requestRestart(reason: string): Promise<void>
  state(): GramJSSessionState
  /** Seconds the current pass has been waiting for a peer's lock (0 = not waiting). */
  lockWaitSeconds(): number
  /** Stops retry loops; bounded wait for an in-flight pass. */
  stop(timeoutMs?: number): Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createGramJSLifecycle(options: GramJSLifecycleOptions): GramJSLifecycle {
  const sleep = options.sleep ?? defaultSleep
  const log = options.log ?? ((message: string) => console.log(`[GramJS lifecycle] ${message}`))
  const lockWaitMs = options.lockWaitMs ?? 15_000
  const maxLockWaitMs = options.maxLockWaitMs ?? 60_000
  const setupRetryDelayMs = options.setupRetryDelayMs ?? 10_000
  const maxTransientStartup = options.maxTransientStartupAttempts ?? 5
  const maxTransientRestart = options.maxTransientRestartAttempts ?? 20

  let state: GramJSSessionState = "starting"
  let stopped = false
  let inflight: Promise<void> | null = null
  let pendingRestart = false
  let lockWaitStartedAt: number | null = null

  function setState(next: GramJSSessionState): void {
    if (state === next) return
    state = next
    options.onStateChange?.(next)
  }

  async function runSetupLoop(mode: "startup" | "restart", reason: string): Promise<void> {
    let transientAttempts = 0
    let lockWait = lockWaitMs

    while (!stopped) {
      try {
        const outcome = await options.setup()
        lockWaitStartedAt = null
        if (outcome === "unconfigured") {
          setState("unconfigured")
          log("Telegram is not configured — running without a GramJS listener")
        } else {
          setState("active")
          if (mode === "restart") log(`GramJS reconnected (${reason})`)
        }
        return
      } catch (error) {
        const kind = classifyGramJSSetupError(error)
        const message = redactSecrets(error instanceof Error ? error.message : String(error))

        if (kind === "auth-duplicated") {
          lockWaitStartedAt = null
          setState("invalid")
          log("Telegram session is invalidated (AUTH_KEY_DUPLICATED) — re-authenticate in Settings")
          return
        }

        if (kind === "orphan-risk") {
          // A client that cannot be destroyed may keep reconnecting with the
          // same key; building another one risks the very duplication this
          // module exists to prevent. Only a process restart kills it.
          lockWaitStartedAt = null
          setState("starting")
          log(`GramJS client could not be destroyed — refusing to build another: ${message}`)
          options.onFatal?.("GramJS client could not be destroyed")
          return
        }

        if (kind === "lock-unavailable") {
          // A live peer holds the session — expected during a deploy overlap.
          // Wait without consuming the transient budget: that budget is for
          // failures, and a peer holding the lock is not one.
          if (lockWaitStartedAt === null) lockWaitStartedAt = Date.now()
          setState("starting")
          log(`Session lock held by another worker — retrying in ${Math.round(lockWait / 1000)}s`)
          await sleep(lockWait)
          lockWait = Math.min(lockWait * 2, maxLockWaitMs)
          continue
        }

        transientAttempts++
        const maxAttempts = mode === "startup" ? maxTransientStartup : maxTransientRestart
        log(`GramJS setup failed (attempt ${transientAttempts}/${maxAttempts}): ${message}`)
        if (transientAttempts >= maxAttempts) {
          lockWaitStartedAt = null
          if (mode === "restart") {
            log("GramJS setup exhausted all retries — asking for a process restart")
            options.onFatal?.("GramJS setup exhausted all retries")
          } else {
            setState("unavailable")
            log("GramJS setup exhausted all retries — running without Telegram")
          }
          return
        }
        await sleep(setupRetryDelayMs)
      }
    }
  }

  function runPass(reason: string, mode: "startup" | "restart", teardownFirst: boolean): Promise<void> {
    if (inflight) {
      pendingRestart = true
      return inflight
    }

    inflight = (async () => {
      try {
        let first = true
        do {
          pendingRestart = false
          const passMode = first ? mode : "restart"
          // Flip the state before teardown, not after: a 10s destroy would
          // otherwise keep reporting "active" with no client behind it.
          setState("starting")
          if (!(first && !teardownFirst)) await options.teardown()
          first = false
          await runSetupLoop(passMode, reason)
        } while (pendingRestart && !stopped)
      } finally {
        inflight = null
      }
    })()

    return inflight
  }

  return {
    start: () => runPass("startup", "startup", false),

    requestRestart: (reason: string) => runPass(reason, "restart", true),

    state: () => state,

    lockWaitSeconds: () => (lockWaitStartedAt === null ? 0 : Math.round((Date.now() - lockWaitStartedAt) / 1000)),

    async stop(timeoutMs = 2_000): Promise<void> {
      stopped = true
      pendingRestart = false
      lockWaitStartedAt = null
      if (inflight) {
        await Promise.race([inflight, sleep(timeoutMs)])
      }
    },
  }
}
