#!/usr/bin/env bash
# Self-host end-to-end check (RAD-292).
#
# For maintainers and CI, not for operators of a live instance. It runs the
# quick start from SELF_HOSTING.md against a throwaway stack and proves what a
# stranger relies on: a clean migration state, both health endpoints, the first
# account becoming ADMIN, a signed-in session, and one onboarding feed served
# from inside the stack.
#
# Run it in a fresh clone of the exported public tree, from anywhere:
#
#     bash scripts/selfhost-e2e.sh
#
# A .env in the checkout is refused: its keys (AI, R2, Resend, Stripe, …) would
# reach the throwaway stack, and ALLOW_UNVERIFIED_SIGNUP=0 would send real mail.
# SELFHOST_E2E_USE_EXISTING_ENV=1 accepts that on purpose.
#
# Port 3000 must be free. Every compose call is pinned to the project name
# `radaric-e2e`, so a real install on the same machine keeps its containers and
# its db-data volume untouched. Nothing is touched before the stack is started:
# a failed precondition leaves an existing .env alone. On success the stack, its
# volumes and the image built for it are removed, and a .env this script created
# is deleted. The private development checkout is refused: its migration chain
# cannot build an empty database.
#
# Environment:
#   SELFHOST_E2E_USE_EXISTING_ENV=1  load the checkout's .env into the stack
#   SELFHOST_E2E_KEEP=1              keep the stack, .env and work dir
#   SELFHOST_E2E_DIAGNOSTICS=<file>  also write the failure dump to <file>
#
# Needs: bash, docker with the compose plugin, curl, node, openssl.
#
# What it does not cover: AI evaluation with a real key (a parse without a key
# stores nothing, so only the source row is asserted), Telegram, Twitter/X,
# Stripe, and mail delivery.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT=3000
BASE_URL="http://localhost:$PORT"
ADMIN_EMAIL="e2e-admin@example.test"
USER_EMAIL="e2e-user@example.test"
# `isAllowedUrl` compares hostnames without resolving DNS, so a compose service
# name passes. If resolution is ever added to that guard, the fixture needs an
# explicit test-only allowance, never a looser check for every caller.
FEED_URL="http://rssfixture/feed.xml"

CHECKS=0
ENV_CREATED=0
STACK_STARTED=0
STEP="start"
CODE=""
WORK="$(mktemp -d "${TMPDIR:-/tmp}/radaric-e2e.XXXXXX")"

# The only place that calls compose. `-p` keeps this check out of any real
# install's project; the fixture override adds the RSS server the feed step uses.
dc() {
  docker compose -p radaric-e2e \
    -f docker-compose.yml \
    -f scripts/selfhost-e2e/compose.fixture.yml \
    "$@"
}

step() {
  STEP="$1"
  printf '\nstep: %s\n' "$STEP"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

expect_eq() { # <label> <expected> <actual>
  if [ "$2" != "$3" ]; then
    fail "$1 (expected [$2], got [$3])"
  fi
  CHECKS=$((CHECKS + 1))
}

expect_http_2xx() { # <label> <status>
  case "$2" in
    2[0-9][0-9]) CHECKS=$((CHECKS + 1)) ;;
    *) fail "$1 (HTTP $2)" ;;
  esac
}

# Top-level field or dotted path, e.g. `status` or `user.email`.
json_get() { # <file> <path>
  node -e '
    const fs = require("fs")
    const [file, path] = process.argv.slice(1)
    let value = JSON.parse(fs.readFileSync(file, "utf8"))
    for (const key of path.split(".")) value = value == null ? undefined : value[key]
    process.stdout.write(value === undefined || value === null ? "" : String(value))
  ' "$1" "$2"
}

db_scalar() { # <sql> — single value, whitespace stripped
  dc exec -T db psql -U radaric -d radaric -tAc "$1" | tr -d '[:space:]'
}

port_in_use() { # <port> — bash's /dev/tcp first; nc only where bash lacks it
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && return 0
  (exec 3<>"/dev/tcp/::1/$1") >/dev/null 2>&1 && return 0
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1 && return 0
    nc -z ::1 "$1" >/dev/null 2>&1 && return 0
  fi
  return 1
}

fetch() { # <path> <outfile> [cookie jar] — sets CODE
  local path="$1" out="$2" jar="${3:-}"
  if [ -n "$jar" ]; then
    CODE=$(curl -sS --max-time 30 -c "$jar" -b "$jar" -o "$out" -w '%{http_code}' "$BASE_URL$path")
  else
    CODE=$(curl -sS --max-time 30 -o "$out" -w '%{http_code}' "$BASE_URL$path")
  fi
}

post_json() { # <path> <body> <outfile> [cookie jar] — sets CODE
  local path="$1" body="$2" out="$3" jar="${4:-}"
  local args=(-sS --max-time 60 -o "$out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data "$body")
  if [ -n "$jar" ]; then
    CODE=$(curl "${args[@]}" -b "$jar" "$BASE_URL$path")
  else
    CODE=$(curl "${args[@]}" "$BASE_URL$path")
  fi
}

expect_http_answer() { # <label> <status> — 2xx or 3xx: the auth callback redirects
  case "$2" in
    2[0-9][0-9]|3[0-9][0-9]) CHECKS=$((CHECKS + 1)) ;;
    *) fail "$1 (HTTP $2)" ;;
  esac
}

wait_healthy() { # [started_at] — 6 minutes; with started_at, only a later start counts
  local not_before="${1:-}"
  local deadline=$((SECONDS + 360))
  local id status started
  while [ "$SECONDS" -lt "$deadline" ]; do
    id=$(dc ps -q app 2>/dev/null || true)
    status=""
    started=""
    if [ -n "$id" ]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || true)
      started=$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null || true)
      # A restart resets the container; until it has, a `healthy` reading still
      # describes the previous process and must not be believed.
      if [ -n "$not_before" ] && [ "$started" = "$not_before" ]; then
        status="starting"
      fi
    fi
    if [ "$status" = "healthy" ]; then
      CHECKS=$((CHECKS + 1))
      return 0
    fi
    if [ "$status" = "unhealthy" ]; then
      fail "the app container reported unhealthy"
    fi
    sleep 5
  done
  fail "the app container did not become healthy within 6 minutes"
}

probe_health() {
  fetch "/api/health" "$WORK/health.json" || fail "GET /api/health did not answer"
  expect_eq "GET /api/health HTTP status" "200" "$CODE"
  expect_eq "GET /api/health body status" "ok" "$(json_get "$WORK/health.json" status)"

  local worker
  worker=$(dc exec -T app node -e '
    fetch("http://127.0.0.1:3001/health")
      .then(async (res) => console.log(res.status + " " + (await res.json()).status))
      .catch(() => process.exit(1))
  ') || fail "the worker /health probe did not answer"
  expect_eq "worker /health (HTTP status, body status)" "200 unconfigured" "$worker"
}

check_migrate_log() { # <label>
  # scripts/migrate-safe.js decides from a try/catch around execSync, so its
  # "prisma migrate deploy failed, attempting to resolve failed migrations"
  # line appears only when the deploy actually failed. The signals that mean
  # something are a migration that had to be resolved, and a deploy that never
  # printed its success line.
  local logs
  logs=$(dc logs app 2>&1 || true)
  case "$logs" in
    *"Resolving failed migration:"*)
      fail "$1: migrate-safe resolved a failed migration — see the app log" ;;
  esac
  case "$logs" in
    *"All migrations have been successfully applied."*|*"No pending migrations to apply."*) ;;
    *) fail "$1: prisma migrate deploy printed no success line — see the app log" ;;
  esac
  CHECKS=$((CHECKS + 1))
}

dump_diagnostics() {
  local out="$WORK/diagnostics.txt"
  printf 'step: %s\n\n--- compose ps ---\n' "$STEP" > "$out"
  dc ps >> "$out" 2>&1 || true
  printf '\n--- app logs (last 200 lines) ---\n' >> "$out"
  dc logs --tail 200 app >> "$out" 2>&1 || true
  cat "$out" >&2
  if [ -n "${SELFHOST_E2E_DIAGNOSTICS:-}" ]; then
    cp "$out" "$SELFHOST_E2E_DIAGNOSTICS" || true
  fi
}

teardown() {
  if [ "${SELFHOST_E2E_KEEP:-0}" = "1" ]; then
    printf '\nkept the stack (SELFHOST_E2E_KEEP=1): %s\n' "$BASE_URL"
    printf 'admin: %s / %s\n' "$ADMIN_EMAIL" "${PASSWORD:-<not generated>}"
    printf 'work dir: %s\n' "$WORK"
    if [ "$ENV_CREATED" = "1" ]; then
      printf '.env: generated by this run\n'
    else
      printf '.env: the one that was already here, untouched\n'
    fi
    return 0
  fi
  step "teardown"
  if [ "$STACK_STARTED" = "1" ]; then
    if ! dc down -v --remove-orphans --rmi local >/dev/null 2>&1; then
      printf 'WARN: teardown failed — run: docker compose -p radaric-e2e down -v --remove-orphans --rmi local\n' >&2
    fi
    leftover=$(docker volume ls -q --filter label=com.docker.compose.project=radaric-e2e 2>/dev/null || true)
    if [ -n "$leftover" ]; then
      printf 'WARN: volume(s) left behind: %s\n' "$(printf '%s' "$leftover" | tr '\n' ' ')" >&2
    fi
  fi
  # Remove .env only when this run created it, including a half-written file
  # left by a generator that failed after `: > .env`. A failed precondition
  # never reaches here with the flag set, so an operator's .env survives.
  if [ "$ENV_CREATED" = "1" ]; then
    rm -f "$ROOT/.env"
  fi
  rm -rf "$WORK"
}

on_exit() {
  local status=$?
  local failed_step="$STEP"
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    dump_diagnostics || true
  fi
  teardown || true
  if [ "$status" -eq 0 ]; then
    printf '\nSELFHOST-E2E: PASS (%s checks)\n' "$CHECKS"
  else
    printf '\nSELFHOST-E2E: FAIL %s\n' "$failed_step"
  fi
  exit "$status"
}
trap on_exit EXIT

# --- 1. preconditions ------------------------------------------------------
# Nothing here may touch the checkout: a failed precondition must leave an
# operator's .env byte-identical, so ownership flags stay 0 until the env and
# stack steps set them.
step "preconditions"
if [ -f .env ] && [ "${SELFHOST_E2E_USE_EXISTING_ENV:-0}" != "1" ]; then
  fail "this checkout already has a .env — run the check in a fresh clone, never in the directory of a running install; set SELFHOST_E2E_USE_EXISTING_ENV=1 only if every key in it may reach the throwaway stack"
fi
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable — start Docker or Colima first"
dc version >/dev/null 2>&1 || fail "the compose plugin (v2) is required"
for tool in curl node openssl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed and this check needs it"
done
[ -f docker-compose.yml ] && [ -d prisma/migrations ] \
  || fail "run this from a Radaric checkout — docker-compose.yml or prisma/migrations is missing in $ROOT"
[ -d prisma/migrations/20261022180001_public_baseline ] \
  || fail "this checkout carries the private migration chain, which cannot build an empty database — run the check in the exported public tree"
if port_in_use "$PORT"; then
  fail "port $PORT is already in use — stop that process first, the stack publishes there"
fi
leftover_containers=$(docker ps -aq --filter label=com.docker.compose.project=radaric-e2e 2>/dev/null || true)
if [ -n "$leftover_containers" ]; then
  fail "containers from the radaric-e2e project already exist (a previous run or another checkout) — remove them first: docker compose -p radaric-e2e down -v --remove-orphans"
fi

# --- 2. environment file, exactly as the quick start makes it --------------
step "env"
if [ -f .env ]; then
  printf 'using the existing .env — every key in it reaches the throwaway stack\n'
else
  ENV_CREATED=1
  sh scripts/generate-env.sh
fi
[ -f .env ] || fail ".env is missing and the generator did not create it"

# --- 3. the stack ----------------------------------------------------------
step "stack"
dc config --quiet || fail "the compose files do not validate — see the message above"
STACK_STARTED=1
dc up -d --build

# --- 4. health -------------------------------------------------------------
step "health"
wait_healthy
probe_health

# --- 5. migrations ---------------------------------------------------------
step "migrations"
check_migrate_log "migrations"
bad=$(db_scalar "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR logs IS NOT NULL") \
  || fail "could not read _prisma_migrations from the database"
expect_eq "failed, rolled-back or logging migration rows" "0" "$bad"

applied=$(dc exec -T db psql -U radaric -d radaric -tAc "SELECT migration_name FROM _prisma_migrations" | LC_ALL=C sort) \
  || fail "could not list the applied migrations"
folders=$(for dir in prisma/migrations/*/; do basename "$dir"; done | LC_ALL=C sort)
expect_eq "applied migrations equal prisma/migrations/" "$folders" "$applied"

dc exec -T app npx --no-install prisma --version >/dev/null 2>&1 \
  || fail "the prisma CLI is missing from the image — the drift check cannot run"

drift_status=0
# shellcheck disable=SC2016 # $DATABASE_URL expands inside the container, not here
dc exec -T app sh -c 'npx --no-install prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code' \
  || drift_status=$?
if [ "$drift_status" -eq 2 ]; then
  fail "prisma migrate diff reports drift between the migrations and schema.prisma"
elif [ "$drift_status" -ne 0 ]; then
  fail "prisma migrate diff failed (exit $drift_status)"
fi
CHECKS=$((CHECKS + 1))

# --- 6. first account becomes ADMIN ---------------------------------------
step "first-admin"
PASSWORD=$(openssl rand -hex 16)
post_json "/api/auth/signup" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASSWORD\"}" "$WORK/signup-admin.json" \
  || fail "POST /api/auth/signup (first account) did not answer"
expect_http_2xx "first sign-up" "$CODE"
expect_eq "first account role" "ADMIN" "$(db_scalar "SELECT role FROM users WHERE email = '$ADMIN_EMAIL'")"

post_json "/api/auth/signup" "{\"email\":\"$USER_EMAIL\",\"password\":\"$PASSWORD\"}" "$WORK/signup-user.json" \
  || fail "POST /api/auth/signup (second account) did not answer"
expect_http_2xx "second sign-up" "$CODE"
expect_eq "second account role" "USER" "$(db_scalar "SELECT role FROM users WHERE email = '$USER_EMAIL'")"

# --- 7. signed-in session --------------------------------------------------
step "session"
JAR="$WORK/cookies.txt"
fetch "/api/auth/csrf" "$WORK/csrf.json" "$JAR" || fail "GET /api/auth/csrf did not answer"
expect_eq "GET /api/auth/csrf" "200" "$CODE"
CSRF=$(json_get "$WORK/csrf.json" csrfToken)
[ -n "$CSRF" ] || fail "the CSRF response carried no token"

CODE=$(curl -sS --max-time 30 -c "$JAR" -b "$JAR" -o "$WORK/callback.json" -D "$WORK/callback.headers" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'X-Auth-Return-Redirect: 1' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=$ADMIN_EMAIL" \
  --data-urlencode "password=$PASSWORD" \
  --data-urlencode "callbackUrl=$BASE_URL/" \
  --data-urlencode "json=true" \
  "$BASE_URL/api/auth/callback/credentials") \
  || fail "POST /api/auth/callback/credentials did not answer"
expect_http_answer "credentials callback" "$CODE"
# Auth.js answers a rejected sign-in with 302 (or 200 {url}) to /api/auth/error,
# which the status check alone would accept.
if grep -qi 'CredentialsSignin\|/api/auth/error' "$WORK/callback.json" "$WORK/callback.headers"; then
  fail "the credentials callback rejected the sign-in: $(cat "$WORK/callback.json")"
fi
CHECKS=$((CHECKS + 1))

fetch "/api/auth/session" "$WORK/session.json" "$JAR" || fail "GET /api/auth/session did not answer"
expect_eq "GET /api/auth/session" "200" "$CODE"
expect_eq "session email" "$ADMIN_EMAIL" "$(json_get "$WORK/session.json" user.email)"

fetch "/api/user-settings" "$WORK/user-settings.json" "$JAR" || fail "GET /api/user-settings did not answer"
expect_eq "GET /api/user-settings (signed in)" "200" "$CODE"

# --- 8. onboarding feed, served from inside the stack ---------------------
step "feed"
post_json "/api/onboarding/validate-feed" "{\"url\":\"$FEED_URL\"}" "$WORK/validate-feed.json" "$JAR" \
  || fail "POST /api/onboarding/validate-feed did not answer"
expect_eq "validate-feed HTTP" "200" "$CODE"
expect_eq "validate-feed valid" "true" "$(json_get "$WORK/validate-feed.json" valid)"
expect_eq "validate-feed itemCount" "3" "$(json_get "$WORK/validate-feed.json" itemCount)"

post_json "/api/onboarding/save-feeds" \
  "{\"feeds\":[{\"name\":\"Self-host fixture\",\"url\":\"$FEED_URL\",\"type\":\"RSS\"}]}" \
  "$WORK/save-feeds.json" "$JAR" \
  || fail "POST /api/onboarding/save-feeds did not answer"
expect_eq "save-feeds HTTP" "201" "$CODE"
expect_eq "save-feeds created" "1" "$(json_get "$WORK/save-feeds.json" created)"
expect_eq "sources row for the fixture feed" "1" "$(db_scalar "SELECT count(*) FROM sources WHERE url = '$FEED_URL'")"

# --- 9. restart is idempotent ---------------------------------------------
step "restart"
app_id=$(dc ps -q app)
[ -n "$app_id" ] || fail "the app container is missing before the restart"
started_before=$(docker inspect -f '{{.State.StartedAt}}' "$app_id") \
  || fail "could not read the app container's start time"
migrations_before=$(db_scalar "SELECT count(*) FROM _prisma_migrations") \
  || fail "could not count the applied migrations before the restart"
dc restart app || fail "compose restart app failed"
wait_healthy "$started_before"
probe_health
check_migrate_log "restart"
bad=$(db_scalar "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
expect_eq "failed or unfinished migration rows after restart" "0" "$bad"
expect_eq "applied migration count after restart" "$migrations_before" "$(db_scalar "SELECT count(*) FROM _prisma_migrations")"
