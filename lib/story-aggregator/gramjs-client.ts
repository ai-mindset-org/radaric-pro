/**
 * GramJS client lifecycle helpers (RAD-328).
 *
 * GramJS's `TelegramClient.connect()` has two failure shapes and neither one
 * cleans up after itself:
 *   - it returns `false` when the TCP sender cannot connect, and before
 *     returning it arms an internal update loop that reconnects forever;
 *   - it throws for RPC failures during initialization (e.g. 406
 *     AUTH_KEY_DUPLICATED), leaving the sender to retry on its own.
 *
 * A client that failed either way is never referenced by the worker, never
 * destroyed, and keeps reconnecting with the same auth key — the orphan that
 * hammered Telegram every ~90s in production. Every connect attempt therefore
 * goes through `connectTelegramClient`, which destroys the client on failure.
 */

import { GramJSClientDestroyError } from "./gramjs-errors"

interface ConnectableClient {
  connect(): Promise<unknown>
  destroy(): Promise<unknown>
  connected?: boolean
}

const DEFAULT_DESTROY_TIMEOUT_MS = 10_000

/**
 * Best-effort, timeout-bounded destroy.
 *
 * Returns `true` when the client is gone (or there was nothing to destroy) and
 * `false` when destroy threw or timed out — a live sender may still be
 * reconnecting with the same auth key, and the caller must not build a second
 * client while that is possible.
 */
export async function destroyTelegramClient(
  client: { destroy?: () => Promise<unknown> } | null | undefined,
  timeoutMs = DEFAULT_DESTROY_TIMEOUT_MS
): Promise<boolean> {
  if (!client || typeof client.destroy !== "function") return true

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await Promise.race([
      client.destroy().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    return result
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The one place that knows the disposal order: the client must be gone before
 * the session lock is released, or a peer can connect while our socket is
 * still live. If the client survives its destroy, the lock is deliberately
 * kept — the caller's `onDestroyFailed` is expected to end the process, which
 * kills the orphan for certain.
 */
export async function disposeGramJSSession(deps: {
  destroyClient: () => Promise<boolean>
  releaseLock: () => Promise<void>
  onDestroyFailed?: () => void
}): Promise<boolean> {
  const destroyed = await deps.destroyClient()
  if (!destroyed) {
    deps.onDestroyFailed?.()
    return false
  }
  await deps.releaseLock()
  return true
}

/**
 * Connect and prove the client is alive; on any failure destroy it and rethrow.
 * The thrown error is the original when there was one, so callers can classify
 * (e.g. AUTH_KEY_DUPLICATED) without unwrapping — unless the client could not
 * be destroyed, which is its own hazard (`GramJSClientDestroyError`).
 */
export async function connectTelegramClient<T extends ConnectableClient>(
  client: T,
  destroyTimeoutMs = DEFAULT_DESTROY_TIMEOUT_MS
): Promise<T> {
  try {
    const result = await client.connect()
    if (result === false || client.connected === false) {
      throw new Error("GramJS client failed to connect")
    }
    return client
  } catch (error) {
    const destroyed = await destroyTelegramClient(client, destroyTimeoutMs)
    if (!destroyed) {
      throw new GramJSClientDestroyError(
        `Client failed to connect and could not be destroyed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    throw error
  }
}
