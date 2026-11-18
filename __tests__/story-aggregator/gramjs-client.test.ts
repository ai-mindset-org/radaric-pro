/**
 * GramJS client lifecycle + setup-error classification — RAD-328.
 *
 * The production orphan was a client whose `connect()` failed and was never
 * destroyed: GramJS keeps its sender retrying forever, so the worker leaked a
 * connection that hammered Telegram with the dead auth key every ~90 seconds.
 * These tests pin the cleanup contract and the retry classification.
 */

import { describe, it, expect, vi } from "vitest"
import {
  connectTelegramClient,
  destroyTelegramClient,
  disposeGramJSSession,
} from "@/lib/story-aggregator/gramjs-client"
import {
  GramJSClientDestroyError,
  GramJSLockUnavailableError,
  classifyGramJSSetupError,
  redactSecrets,
} from "@/lib/story-aggregator/gramjs-errors"

function makeClient(overrides: {
  connect?: () => Promise<unknown>
  destroy?: () => Promise<unknown>
  connected?: boolean
} = {}) {
  return {
    connect: vi.fn(overrides.connect ?? (async () => true)),
    destroy: vi.fn(overrides.destroy ?? (async () => undefined)),
    connected: overrides.connected ?? true,
  }
}

describe("connectTelegramClient (RAD-328)", () => {
  it("returns the client on a successful connect", async () => {
    const client = makeClient()
    await expect(connectTelegramClient(client)).resolves.toBe(client)
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it("destroys the client and throws when connect() resolves false", async () => {
    // GramJS's connect() reports TCP failure as `false` and arms its internal
    // update loop before returning — the exact orphan shape from production.
    const client = makeClient({ connect: async () => false })
    await expect(connectTelegramClient(client)).rejects.toThrow("failed to connect")
    expect(client.destroy).toHaveBeenCalledTimes(1)
  })

  it("destroys the client and throws when connect() resolves true but the client is not connected", async () => {
    const client = makeClient({ connected: false })
    await expect(connectTelegramClient(client)).rejects.toThrow("failed to connect")
    expect(client.destroy).toHaveBeenCalledTimes(1)
  })

  it("destroys the client and rethrows the original error when connect() throws", async () => {
    const rpcError = Object.assign(new Error("406: AUTH_KEY_DUPLICATED"), {
      errorMessage: "AUTH_KEY_DUPLICATED",
    })
    const client = makeClient({
      connect: async () => {
        throw rpcError
      },
    })
    await expect(connectTelegramClient(client)).rejects.toBe(rpcError)
    expect(client.destroy).toHaveBeenCalledTimes(1)
  })

  it("throws an orphan-risk error when the client cannot be destroyed after a failed connect", async () => {
    const rpcError = new Error("InvokeWithLayer")
    const client = makeClient({
      connect: async () => {
        throw rpcError
      },
      destroy: async () => {
        throw new Error("destroy exploded")
      },
    })
    await expect(connectTelegramClient(client)).rejects.toBeInstanceOf(GramJSClientDestroyError)
  })
})

describe("destroyTelegramClient (RAD-328)", () => {
  it("reports true when destroy succeeds", async () => {
    const client = makeClient()
    await expect(destroyTelegramClient(client)).resolves.toBe(true)
  })

  it("reports false when destroy rejects", async () => {
    const client = makeClient({ destroy: async () => {
      throw new Error("already dead")
    } })
    await expect(destroyTelegramClient(client)).resolves.toBe(false)
  })

  it("reports false after the timeout when destroy hangs, without leaking the timer", async () => {
    vi.useFakeTimers()
    try {
      const client = {
        destroy: vi.fn(() => new Promise<void>(() => {})),
      }
      const pending = destroyTelegramClient(client, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports true for null/undefined clients (nothing to destroy)", async () => {
    await expect(destroyTelegramClient(null)).resolves.toBe(true)
    await expect(destroyTelegramClient(undefined)).resolves.toBe(true)
  })
})

describe("disposeGramJSSession (RAD-328)", () => {
  it("destroys the client before releasing the lock", async () => {
    const order: string[] = []
    await disposeGramJSSession({
      destroyClient: async () => {
        order.push("destroy")
        return true
      },
      releaseLock: async () => {
        order.push("release")
      },
    })
    expect(order).toEqual(["destroy", "release"])
  })

  it("keeps the lock and reports failure when the client cannot be destroyed", async () => {
    const onDestroyFailed = vi.fn()
    const releaseLock = vi.fn(async () => undefined)
    const result = await disposeGramJSSession({
      destroyClient: async () => false,
      releaseLock,
      onDestroyFailed,
    })
    expect(result).toBe(false)
    expect(releaseLock).not.toHaveBeenCalled()
    expect(onDestroyFailed).toHaveBeenCalledTimes(1)
  })
})

describe("classifyGramJSSetupError (RAD-328)", () => {
  it("classifies the lock-unavailable error as retryable-on-lock", () => {
    expect(classifyGramJSSetupError(new GramJSLockUnavailableError())).toBe("lock-unavailable")
  })

  it("classifies AUTH_KEY_DUPLICATED as permanent, whichever field carries it", () => {
    expect(classifyGramJSSetupError({ errorMessage: "AUTH_KEY_DUPLICATED", code: 406 })).toBe("auth-duplicated")
    expect(classifyGramJSSetupError(new Error("406: AUTH_KEY_DUPLICATED"))).toBe("auth-duplicated")
    expect(classifyGramJSSetupError({ errorMessage: "AUTH_KEY_UNREGISTERED" })).toBe("auth-duplicated")
  })

  it("keeps FLOOD_WAIT and other 406-class errors transient", () => {
    expect(classifyGramJSSetupError({ errorMessage: "FLOOD", message: "A wait of 42 seconds is required", code: 420 })).toBe("transient")
    expect(classifyGramJSSetupError({ errorMessage: "CHANNEL_PRIVATE", code: 406 })).toBe("transient")
  })

  it("treats network errors, timeouts and unknown shapes as transient", () => {
    expect(classifyGramJSSetupError(new Error("connection refused"))).toBe("transient")
    expect(classifyGramJSSetupError(new Error("Ping timeout"))).toBe("transient")
    expect(classifyGramJSSetupError(undefined)).toBe("transient")
    expect(classifyGramJSSetupError("boom")).toBe("transient")
  })

  it("classifies an undestroyable client as orphan-risk, not a plain retry", () => {
    expect(classifyGramJSSetupError(new GramJSClientDestroyError())).toBe("orphan-risk")
  })
})

describe("redactSecrets (RAD-328)", () => {
  it("strips credentials from datasource URLs in log lines", () => {
    expect(redactSecrets("P1013: url postgres://user:hunter2@db.example.com:5432/x is invalid")).toBe(
      "P1013: url postgres://***:***@db.example.com:5432/x is invalid"
    )
  })

  it("leaves lines without credentials untouched", () => {
    expect(redactSecrets("connection refused")).toBe("connection refused")
  })
})
