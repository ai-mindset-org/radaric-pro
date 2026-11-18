#!/bin/sh
# Runs as PID 1 on Railway so SIGTERM propagates to both the story-aggregator
# worker and Next.js. Without this, `... & next start` leaves the worker
# SIGKILLed on deploy, `shutdown()` never runs, GramJS never `destroy()`s, and
# Telegram invalidates the session with AUTH_KEY_DUPLICATED (see
# docs/TELEGRAM_SETUP.md §8).
set -e

# Make locally-installed binaries resolvable regardless of how the builder
# invokes this script: npm-launched shells include node_modules/.bin, but a bare
# `sh scripts/start.sh` may not, and a deploy once failed with `next: not found`
# for exactly that reason. APPENDED so an explicitly-provided binary (or a test
# stub) still wins.
PATH="$PATH:$(pwd)/node_modules/.bin"; export PATH

node scripts/migrate-safe.js

npx tsx lib/story-aggregator/worker.ts &
WORKER_PID=$!

next start &
NEXT_PID=$!

term() {
  echo "[start.sh] Signal received, forwarding SIGTERM to children (worker=$WORKER_PID, next=$NEXT_PID)"
  kill -TERM "$WORKER_PID" "$NEXT_PID" 2>/dev/null || true
  # PID 1 must OUTLIVE its children. When the init process of a PID namespace
  # exits, the kernel SIGKILLs every process in it — so without this wait the
  # worker's shutdown() (GramJS destroy, queue drain) is truncated the moment
  # Docker/Railway stops the container, which is the AUTH_KEY_DUPLICATED class
  # this script exists to prevent. Block until both children are reaped, then
  # let the container exit. (RAD-286 review; verified locally against the
  # identical trap-without-wait shape.)
  wait "$WORKER_PID" "$NEXT_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT

# `wait` (no args) waits for all backgrounded jobs. When SIGTERM arrives, the
# trap forwards it to both children, WAITS for them to run their own shutdown
# handlers, and exits only once they are gone.
wait
