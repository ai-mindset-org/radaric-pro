/**
 * GramJS session lifecycle — RAD-328.
 *
 * This is the state owner the worker was missing: one pass at a time, restarts
 * queued instead of dropped, and a session state that distinguishes "waiting
 * for the lock / connecting" from "your session is dead, re-authenticate".
 * The production failure modes under test: a restart requested while another
 * pass is in flight must be replayed, and a lock held by a live peer must be
 * retried without consuming the failure budget.
 */

import { describe, it, expect, vi } from "vitest"
import { createGramJSLifecycle, type GramJSLifecycleOptions, type GramJSSessionState } from "@/lib/story-aggregator/gramjs-lifecycle"
import { GramJSClientDestroyError, GramJSLockUnavailableError } from "@/lib/story-aggregator/gramjs-errors"

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function makeLifecycle(overrides: Partial<GramJSLifecycleOptions> = {}) {
  const sleeps: number[] = []
  const states: GramJSSessionState[] = []
  const setup = overrides.setup ?? vi.fn(async () => "connected" as const)
  const teardown = overrides.teardown ?? vi.fn(async () => undefined)
  const lifecycle = createGramJSLifecycle({
    setup,
    teardown,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      // Yield a real macrotask: a retry loop whose sleep resolves as a
      // microtask would starve timers (and the test's own flush()).
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    },
    log: () => undefined,
    onStateChange: (state) => states.push(state),
    ...overrides,
  })
  return { lifecycle, setup, teardown, sleeps, states }
}

describe("GramJS lifecycle (RAD-328)", () => {
  it("start(): connects without a teardown and reports active", async () => {
    const { lifecycle, setup, teardown, states } = makeLifecycle()
    await lifecycle.start()
    expect(setup).toHaveBeenCalledTimes(1)
    expect(teardown).not.toHaveBeenCalled()
    expect(lifecycle.state()).toBe("active")
    // Initial state is already "starting", so only the transition is emitted.
    expect(states).toEqual(["active"])
  })

  it("start(): an unconfigured worker idles in the unconfigured state", async () => {
    const { lifecycle, setup } = makeLifecycle({ setup: vi.fn(async () => "unconfigured" as const) })
    await lifecycle.start()
    expect(lifecycle.state()).toBe("unconfigured")
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it("retries a lock held by a live peer without consuming the transient budget", async () => {
    const setup = vi
      .fn()
      .mockRejectedValueOnce(new GramJSLockUnavailableError())
      .mockRejectedValueOnce(new GramJSLockUnavailableError())
      .mockResolvedValueOnce("connected")
    const { lifecycle, sleeps } = makeLifecycle({ setup, lockWaitMs: 15_000, maxLockWaitMs: 60_000 })
    await lifecycle.start()
    expect(setup).toHaveBeenCalledTimes(3)
    expect(lifecycle.state()).toBe("active")
    expect(sleeps).toEqual([15_000, 30_000])
  })

  it("caps the lock-wait backoff but keeps waiting indefinitely", async () => {
    const setup = vi
      .fn()
      .mockRejectedValueOnce(new GramJSLockUnavailableError())
      .mockRejectedValueOnce(new GramJSLockUnavailableError())
      .mockRejectedValueOnce(new GramJSLockUnavailableError())
      .mockRejectedValueOnce(new GramJSLockUnavailableError())
      .mockResolvedValueOnce("connected")
    const { lifecycle, sleeps } = makeLifecycle({ setup, lockWaitMs: 15_000, maxLockWaitMs: 60_000 })
    await lifecycle.start()
    expect(sleeps).toEqual([15_000, 30_000, 60_000, 60_000])
    expect(lifecycle.state()).toBe("active")
  })

  it("gives up after the startup transient budget without asking for a restart", async () => {
    const onFatal = vi.fn()
    const setup = vi.fn(async () => {
      throw new Error("connection refused")
    })
    const { lifecycle, sleeps } = makeLifecycle({ setup, onFatal, maxTransientStartupAttempts: 3 })
    await lifecycle.start()
    expect(setup).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([10_000, 10_000])
    expect(onFatal).not.toHaveBeenCalled()
    // Not "starting" — nothing will retry, and the badge must not claim it will.
    expect(lifecycle.state()).toBe("unavailable")
  })

  it("an undestroyable client is fatal — never builds a second client over an orphan", async () => {
    const onFatal = vi.fn()
    const setup = vi.fn(async () => {
      throw new GramJSClientDestroyError()
    })
    const { lifecycle } = makeLifecycle({ setup, onFatal })
    await lifecycle.start()
    expect(setup).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledTimes(1)
  })

  it("auth-duplicated is permanent: no retries, state invalid", async () => {
    const setup = vi.fn(async () => {
      throw Object.assign(new Error("406: AUTH_KEY_DUPLICATED"), { errorMessage: "AUTH_KEY_DUPLICATED" })
    })
    const { lifecycle, sleeps } = makeLifecycle({ setup })
    await lifecycle.start()
    expect(setup).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
    expect(lifecycle.state()).toBe("invalid")
  })

  it("a re-auth restart can leave the invalid state", async () => {
    const setup = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("406: AUTH_KEY_DUPLICATED"), { errorMessage: "AUTH_KEY_DUPLICATED" }))
      .mockResolvedValueOnce("connected")
    const { lifecycle } = makeLifecycle({ setup })
    await lifecycle.start()
    expect(lifecycle.state()).toBe("invalid")
    await lifecycle.requestRestart("telegram re-auth")
    expect(lifecycle.state()).toBe("active")
  })

  it("requestRestart(): tears down before reconnecting", async () => {
    const order: string[] = []
    const { lifecycle } = makeLifecycle({
      teardown: vi.fn(async () => {
        order.push("teardown")
      }),
      setup: vi.fn(async () => {
        order.push("setup")
        return "connected" as const
      }),
    })
    await lifecycle.start()
    order.length = 0
    await lifecycle.requestRestart("watchdog ping failed")
    expect(order).toEqual(["teardown", "setup"])
    expect(lifecycle.state()).toBe("active")
  })

  it("replays a restart requested while a pass is already in flight (never dropped)", async () => {
    let resolveFirstSetup: (value: "connected") => void = () => undefined
    const setup = vi
      .fn()
      .mockImplementationOnce(() => new Promise<"connected">((resolve) => {
        resolveFirstSetup = resolve
      }))
      .mockResolvedValueOnce("connected")
    const teardown = vi.fn(async () => undefined)
    const { lifecycle } = makeLifecycle({ setup, teardown })

    const startPromise = lifecycle.start()
    await flush()
    // Lock loss reported while the first pass is still connecting.
    const restartPromise = lifecycle.requestRestart("session lock lost")
    resolveFirstSetup("connected")
    await Promise.all([startPromise, restartPromise])

    expect(setup).toHaveBeenCalledTimes(2)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(lifecycle.state()).toBe("active")
  })

  it("restart-mode transient exhaustion asks for a process restart", async () => {
    const onFatal = vi.fn()
    const setup = vi
      .fn()
      .mockResolvedValueOnce("connected")
      .mockImplementation(async () => {
        throw new Error("connection refused")
      })
    const { lifecycle } = makeLifecycle({ setup, onFatal, maxTransientRestartAttempts: 3 })
    await lifecycle.start()
    await lifecycle.requestRestart("watchdog ping failed")
    expect(setup).toHaveBeenCalledTimes(4)
    expect(onFatal).toHaveBeenCalledTimes(1)
  })

  it("stop() halts retry loops without waiting out the backoff", async () => {
    const setup = vi.fn(async () => {
      throw new GramJSLockUnavailableError()
    })
    const { lifecycle } = makeLifecycle({ setup, lockWaitMs: 15_000 })
    const pass = lifecycle.start()
    await flush()
    await lifecycle.stop(50)
    await pass
    expect(lifecycle.state()).toBe("starting")
    expect(setup.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it("reports 'starting' the moment a restart begins, before teardown finishes", async () => {
    let resolveTeardown: () => void = () => undefined
    const teardown = vi.fn(() => new Promise<void>((resolve) => {
      resolveTeardown = resolve
    }))
    const { lifecycle } = makeLifecycle({ setup: vi.fn(async () => "connected" as const), teardown })
    await lifecycle.start()
    const restart = lifecycle.requestRestart("watchdog ping failed")
    await flush()
    // A 10s destroy must not keep reporting active with no client behind it.
    expect(lifecycle.state()).toBe("starting")
    resolveTeardown()
    await restart
    expect(lifecycle.state()).toBe("active")
  })

  it("tracks lock-wait seconds while waiting, and clears them after success", async () => {
    const nowSpy = vi.spyOn(Date, "now")
    nowSpy.mockReturnValueOnce(1_000_000).mockReturnValue(1_006_000)
    try {
      let secondsDuringWait: number | null = null
      const setup = vi
        .fn()
        .mockRejectedValueOnce(new GramJSLockUnavailableError())
        .mockResolvedValueOnce("connected")
      const lifecycle = createGramJSLifecycle({
        setup,
        teardown: vi.fn(async () => undefined),
        sleep: async () => {
          secondsDuringWait = lifecycle.lockWaitSeconds()
        },
        lockWaitMs: 15_000,
        log: () => undefined,
      })
      await lifecycle.start()
      expect(secondsDuringWait).toBe(6)
      expect(lifecycle.lockWaitSeconds()).toBe(0)
    } finally {
      nowSpy.mockRestore()
    }
  })
})
