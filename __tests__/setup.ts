/**
 * Global Vitest setup — extends expect with custom matchers used across the suite.
 */
import { expect, vi, afterEach } from "vitest"
import { resetRateLimits } from "@/lib/rate-limit"

// RAD-296: the rate limiter is module state shared by every request in a test
// file. Reset between tests so one test's burst cannot 429 the next.
afterEach(() => {
  resetRateLimits()
})

// Stub next/cache globally so API route tests that call revalidatePath /
// revalidateTag don't need a request context. Individual tests can still
// override this mock with vi.mock in their own file if they want to assert
// on the calls.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}))

declare module "vitest" {
  interface Assertion<T> {
    toHaveBeenCalledAtLeast(n: number): T
  }
}

/**
 * toHaveBeenCalledAtLeast(n) — passes when a mock has been called >= n times.
 * Required because Vitest 4.x does not ship this matcher natively.
 */
expect.extend({
  toHaveBeenCalledAtLeast(received: { mock: { calls: unknown[] } }, expected: number) {
    const callCount = received.mock.calls.length
    const pass = callCount >= expected
    return {
      pass,
      message: () =>
        pass
          ? `Expected mock NOT to have been called at least ${expected} time(s), but it was called ${callCount} time(s).`
          : `Expected mock to have been called at least ${expected} time(s), but it was only called ${callCount} time(s).`,
    }
  },
})

/**
 * Warm jsdom's style engine.
 *
 * Testing Library's *ByRole queries call getComputedStyle once per candidate
 * element to decide whether it is accessible (the default `hidden: false`).
 * jsdom builds its cascade machinery lazily on the first such call, and that
 * one-time cost is large — measured on an idle machine it ranged from ~0.5s to
 * ~10s, and it scales badly when several jsdom workers warm up at once. It was
 * charged to whichever test happened to query first, so under CPU contention a
 * different DOM test timed out on every run while every one of them passed in
 * isolation.
 *
 * Paying it here moves it out of the per-test budget: setup files are not bound
 * by testTimeout. The suite does the same total work; it just stops being a
 * lottery over which test absorbs it.
 */
if (typeof window !== "undefined") {
  const probe = document.createElement("button")
  document.body.appendChild(probe)
  window.getComputedStyle(probe).getPropertyValue("display")
  window.getComputedStyle(document.body).getPropertyValue("visibility")
  document.body.removeChild(probe)
}
