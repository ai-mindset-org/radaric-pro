#!/bin/sh
# scripts/generate-env.sh — create/fill the two secrets docker-compose requires.
#
# Run from the repository root: `sh scripts/generate-env.sh` (writes ./.env).
# Idempotent: a key that already has a value is left exactly as it is.
#
# Why a script rather than a block pasted into the guide: pasted into an
# interactive shell, a missing `openssl` used to `exit` the operator's terminal,
# the helper function leaked `key`/`bits`/`tmp` into their shell, and the comment
# lines ran as commands under zsh.
#
# A key present in a shape this script cannot safely rewrite — `KEY: value`, or
# `KEY=` followed only by a `#` comment — stops it with "edit KEY by hand"
# instead of appending a second assignment: compose reads the LAST value, so a
# duplicate would silently change a secret the database volume still expects.
#
# Both values are hex on purpose: POSTGRES_PASSWORD is interpolated raw into
# DATABASE_URL, and a base64 `+` or `/` breaks that connection string.
#
# NEVER regenerate POSTGRES_PASSWORD once the db-data volume exists — Postgres
# keeps the password it was initialised with. See SELF_HOSTING.md.

set -u

# Secrets in a fresh .env; an existing file keeps its own mode (cat > in place).
umask 077

command -v openssl >/dev/null 2>&1 || {
  echo "generate-env: openssl is required to generate the secrets" >&2
  exit 1
}

if [ ! -f .env ]; then
  : > .env || {
    echo "generate-env: cannot create .env in $(pwd)" >&2
    exit 1
  }
fi

ensure_secret() {
  key=$1
  bits=$2

  # Shapes we will not rewrite: `KEY: value` (YAML, not dotenv) and a value that
  # is only a comment (`KEY= # set me`).
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*:" .env; then
    echo "generate-env: edit ${key} by hand in .env (found '${key}: …', expected '${key}=…')" >&2
    exit 1
  fi
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*#" .env; then
    echo "generate-env: edit ${key} by hand in .env (its value is only a # comment)" >&2
    exit 1
  fi

  # Already set: a non-empty value, quoted or bare. Nothing to do.
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(\"[^\"]+\"|'[^']+'|[^\"'#[:space:]])" .env; then
    return 0
  fi

  # Missing or empty: drop every assignment shape for this key, append one value.
  tmp=$(mktemp .env.XXXXXX) || {
    echo "generate-env: cannot create a temp file next to .env" >&2
    exit 1
  }
  grep -vE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" .env > "$tmp"
  printf '%s=%s\n' "$key" "$(openssl rand -hex "$bits")" >> "$tmp" || {
    rm -f "$tmp"
    echo "generate-env: cannot write the new value" >&2
    exit 1
  }
  # Overwrite in place, not `mv`: the inode, the file mode and a symlinked .env
  # all survive.
  if ! cat "$tmp" > .env; then
    rm -f "$tmp"
    echo "generate-env: cannot write .env" >&2
    exit 1
  fi
  rm -f "$tmp"
  echo "generate-env: set ${key} in .env"
}

ensure_secret NEXTAUTH_SECRET 32
# Seals stored integration tokens (Notion) at rest — docs/SECURITY.md. Losing it
# means users paste their Notion token again; keep it with your other secrets.
ensure_secret TOKEN_ENC_KEY 32
ensure_secret POSTGRES_PASSWORD 24
