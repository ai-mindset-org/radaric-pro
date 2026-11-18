#!/bin/bash
# Pre-commit guard: detect linter-induced reverts of prisma/schema.prisma.
#
# Background: ESLint / Prettier / lint-staged occasionally rewrite schema.prisma
# in ways that DROP recently-added enum values, models, or fields — the file
# looks "fixed" but the deletion silently un-does a migration the user just
# wrote.
#
# This script aborts the commit if the staged diff for prisma/schema.prisma
# contains any line deletion (ignoring blank lines and pure-comment lines). It
# does not try to be clever about which deletions are "intentional" vs accidental:
# show the deletions, require an explicit override to proceed.
#
# Override (when the deletion is intentional):
#   SKIP_SCHEMA_GUARD=1 git commit ...
#
# Exit codes: 0 = clean / N/A, 1 = blocked.

set -eu

[ "${SKIP_SCHEMA_GUARD:-0}" = "1" ] && exit 0

SCHEMA="prisma/schema.prisma"

# No schema staged → nothing to check
git diff --cached --name-only | grep -qx "$SCHEMA" || exit 0

# Extract deletions only (lines starting with '-' but not '---')
DELETIONS=$(git diff --cached -U0 -- "$SCHEMA" \
  | awk '/^-[^-]/ && !/^---/ {sub(/^-/, ""); print}' \
  | grep -vE '^[[:space:]]*$' \
  | grep -vE '^[[:space:]]*//' \
  | grep -vE '^[[:space:]]*#' || true)

[ -z "$DELETIONS" ] && exit 0

cat >&2 <<EOF
✗ schema-preservation: prisma/schema.prisma has staged DELETIONS.

The following non-blank, non-comment lines are being removed:
─────────────────────────────────────────────
$DELETIONS
─────────────────────────────────────────────

This guard exists because lint-staged / Prettier have silently reverted
schema.prisma in the past, dropping recently-added enum values or fields.

If the deletion is intentional, override:
  SKIP_SCHEMA_GUARD=1 git commit ...

If you did NOT mean to delete these lines, restore the schema:
  git checkout HEAD -- $SCHEMA
EOF

exit 1
