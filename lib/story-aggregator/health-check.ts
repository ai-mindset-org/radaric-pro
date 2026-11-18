import type { GramJSSessionState } from './gramjs-lifecycle'

export interface HealthStatus {
  /**
   * `unconfigured` — Telegram was never configured (a self-host install without
   * a Telegram session), so there is no listener to miss. Healthy on purpose:
   * a fresh install must not sit `unhealthy` forever (RAD-292).
   */
  status: 'ok' | 'degraded' | 'unconfigured' | 'error'
  gramjs: boolean
  /** Session lifecycle state (RAD-328) — distinguishes "waiting for the lock /
   *  connecting" from "session dead, re-authenticate" for deploy diagnostics. */
  gramjsState: string
  /** Seconds spent waiting for a peer to release the session lock (0 = not waiting). */
  lockWaitSeconds: number
  database: boolean
  lastPollAgo: number
  lastPollStale: boolean
  pendingItems: number
  uptime: number
  errors: string[]
}

const STALE_THRESHOLD_MS = 300_000 // 5 minutes = 300 seconds

export class WorkerHealthCheck {
  private _gramjs: boolean = false
  private _gramjsState: GramJSSessionState = 'starting'
  private _lockWaitSeconds: number = 0
  private _database: boolean = false
  private _lastPoll: number | null = null
  private _pendingItems: number = 0
  private readonly _startTime: number

  constructor() {
    this._startTime = Date.now()
  }

  setGramjsConnected(connected: boolean): void {
    this._gramjs = connected
  }

  setGramjsState(state: GramJSSessionState): void {
    this._gramjsState = state
  }

  setLockWaitSeconds(seconds: number): void {
    this._lockWaitSeconds = seconds
  }

  setDatabaseReachable(reachable: boolean): void {
    this._database = reachable
  }

  recordSuccessfulPoll(): void {
    this._lastPoll = Date.now()
  }

  setPendingItems(count: number): void {
    this._pendingItems = count
  }

  getStatus(): HealthStatus {
    const now = Date.now()

    const lastPollAgo =
      this._lastPoll === null
        ? Infinity
        : (now - this._lastPoll) / 1000

    const lastPollStale =
      this._lastPoll === null || now - this._lastPoll > STALE_THRESHOLD_MS

    const uptime = (now - this._startTime) / 1000

    // Telegram never configured: nothing is expected from the listener, and the
    // poller never started, so "disconnected" and "poll stale" are not failures.
    // Only a reachable database separates this from `error`.
    const telegramUnconfigured =
      this._gramjsState === 'unconfigured' && !this._gramjs

    const errors: string[] = []

    if (!this._gramjs && !telegramUnconfigured) {
      errors.push('GramJS disconnected')
    }

    if (!this._database) {
      errors.push('Database unreachable')
    }

    if (lastPollStale && !telegramUnconfigured) {
      errors.push('Last poll is stale (> 5 min ago)')
    }

    let status: HealthStatus['status']

    if (telegramUnconfigured && this._database) {
      status = 'unconfigured'
    } else if (!this._gramjs || !this._database) {
      status = 'error'
    } else if (lastPollStale) {
      status = 'degraded'
    } else {
      status = 'ok'
    }

    return {
      status,
      gramjs: this._gramjs,
      gramjsState: this._gramjsState,
      lockWaitSeconds: this._lockWaitSeconds,
      database: this._database,
      lastPollAgo,
      lastPollStale,
      pendingItems: this._pendingItems,
      uptime,
      errors,
    }
  }
}

/**
 * HTTP code for a status. Only `error` is 503 — `degraded` and `unconfigured`
 * answer 200, so a container healthcheck (and therefore compose's `restart:
 * unless-stopped`) does not restart-loop a worker that is doing its job.
 *
 * A map, not a ternary: adding a status to `HealthStatus` forces a decision
 * here instead of silently defaulting to healthy.
 */
const HTTP_STATUS_BY_HEALTH: Record<HealthStatus['status'], 200 | 503> = {
  ok: 200,
  degraded: 200,
  unconfigured: 200,
  error: 503,
}

export function healthHttpStatus(status: HealthStatus['status']): 200 | 503 {
  return HTTP_STATUS_BY_HEALTH[status]
}
