import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // Residual margin, after the load-sensitive causes were fixed rather than
    // papered over: the jsdom style engine is warmed once per file in
    // __tests__/setup.ts, the route tests import their dependency graph at
    // collection time, userEvent no longer awaits a macrotask per keystroke, and
    // the parse-stream concurrency test asserts overlap instead of elapsed time.
    // That took the slowest DOM test from ~9.7s to ~2.7s on an idle machine.
    // What is left is real jsdom work, and jsdom runs several times slower when
    // the CPU is contended, so a 5s ceiling is still a bet on an idle machine.
    // 15s is roughly 5x the measured idle worst case. It only bounds how long a
    // genuinely hung test takes to report; it does not slow a passing run.
    testTimeout: 15000,
    setupFiles: ['__tests__/setup.ts'],
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    forceRerunTriggers: ['**/vitest.config.ts', '**/package.json'],
    // next-auth ships ESM that imports `next/server` without an extension, which
    // Node's resolver rejects; inlining lets Vite resolve it. Needed only by the
    // tests that run the real library (__tests__/auth-real-nextauth.test.ts).
    server: { deps: { inline: ['next-auth'] } },
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      thresholds: {
        autoUpdate: true,
        lines: 47,
        functions: 43,
        branches: 70,
        statements: 47,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
