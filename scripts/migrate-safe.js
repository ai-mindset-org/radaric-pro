#!/usr/bin/env node
/**
 * Safe migration runner, run at container boot.
 *
 * Resolves failed migrations before running `prisma migrate deploy`.
 * This handles the case where ALTER TYPE ADD VALUE fails inside a
 * transaction (the enum value gets added but Prisma records the
 * migration as "failed", blocking all subsequent deploys).
 */

const { execSync } = require("child_process")

/**
 * Runs the boot migration flow and returns the process exit code. The exec,
 * log and error functions are injectable so the decision logic can be tested
 * without prisma or a database; `node scripts/migrate-safe.js` uses the real
 * ones.
 */
function main({ exec = execSync, log = console.log, error = console.error } = {}) {
  // true when the command exits 0, false when it fails. With inherited stdio
  // execSync returns null even on success, so its return value cannot be the
  // success signal; only a throw means failure.
  function run(cmd) {
    try {
      exec(cmd, { stdio: "inherit" })
      return true
    } catch {
      return false
    }
  }

  // 1. Try normal migrate deploy first
  log("[migrate-safe] Running prisma migrate deploy...")
  const deployed = run("npx prisma migrate deploy")

  if (deployed) {
    log("[migrate-safe] Migrations applied successfully")
    return 0
  }

  // 2. If it failed, try resolving failed migrations
  log("[migrate-safe] prisma migrate deploy failed, attempting to resolve failed migrations...")

  try {
    // Query _prisma_migrations for failed ones
    const output = exec(
      `node -e "
        const { PrismaClient } = require('@prisma/client');
        const db = new PrismaClient();
        db.\\$queryRaw\\\`
          SELECT migration_name FROM _prisma_migrations
          WHERE rolled_back_at IS NOT NULL
             OR (finished_at IS NULL AND started_at IS NOT NULL)
        \\\`.then(r => { console.log(JSON.stringify(r)); db.\\$disconnect(); })
          .catch(e => { console.error(e.message); db.\\$disconnect(); process.exit(1); })
      "`,
      { encoding: "utf-8" }
    ).trim()

    const failed = JSON.parse(output || "[]")

    if (failed.length > 0) {
      for (const m of failed) {
        log(`[migrate-safe] Resolving failed migration: ${m.migration_name}`)
        run(`npx prisma migrate resolve --applied "${m.migration_name}"`)
      }

      // Retry migrate deploy
      log("[migrate-safe] Retrying prisma migrate deploy...")
      const retried = run("npx prisma migrate deploy")
      if (retried) {
        log("[migrate-safe] Migrations applied successfully after resolve")
        return 0
      }
    }
  } catch (e) {
    error("[migrate-safe] Error resolving migrations:", e.message)
  }

  // 3. Legacy upgrade path for databases created before the enum change: apply
  //    enum values that ALTER TYPE ADD VALUE missed (can't run inside a transaction)
  log("[migrate-safe] Checking for missing enum values...")
  try {
    exec(
      `node -e "
        const { PrismaClient } = require('@prisma/client');
        const db = new PrismaClient();
        (async () => {
          // Check if EVENT_TRIGGER exists in SourceType enum
          const existing = await db.\\$queryRaw\\\`
            SELECT 1 FROM pg_enum
            WHERE enumlabel = 'EVENT_TRIGGER'
              AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'SourceType')
          \\\`;
          if (existing.length === 0) {
            console.log('[migrate-safe] Adding missing EVENT_TRIGGER enum value...');
            await db.\\$executeRawUnsafe('ALTER TYPE \\\"SourceType\\\" ADD VALUE IF NOT EXISTS \\'EVENT_TRIGGER\\'');
            console.log('[migrate-safe] Migrating INTEREST sources to EVENT_TRIGGER...');
            // Need a fresh connection for the new enum value to be visible
            await db.\\$disconnect();
            const db2 = new PrismaClient();
            const updated = await db2.\\$executeRawUnsafe('UPDATE \\\"sources\\\" SET \\\"type\\\" = \\'EVENT_TRIGGER\\' WHERE \\\"type\\\" = \\'INTEREST\\'');
            console.log('[migrate-safe] Migrated ' + updated + ' sources');
            await db2.\\$disconnect();
          } else {
            // Enum exists — check if any sources still need migration
            const stale = await db.\\$queryRaw\\\`
              SELECT count(*)::int as cnt FROM \\\"sources\\\" WHERE \\\"type\\\" = 'INTEREST'
            \\\`;
            if (stale[0]?.cnt > 0) {
              console.log('[migrate-safe] Migrating ' + stale[0].cnt + ' remaining INTEREST sources...');
              await db.\\$executeRawUnsafe('UPDATE \\\"sources\\\" SET \\\"type\\\" = \\'EVENT_TRIGGER\\' WHERE \\\"type\\\" = \\'INTEREST\\'');
            }
            await db.\\$disconnect();
          }
        })().catch(e => { console.error('[migrate-safe] Enum fix error:', e.message); process.exit(0); });
      "`,
      { stdio: "inherit" }
    )
  } catch (e) {
    error("[migrate-safe] Enum fix failed (non-blocking):", e.message)
  }

  // 4. Last resort: just continue — don't block the worker
  error("[migrate-safe] WARNING: Migration issues detected but continuing startup")
  return 0
}

module.exports = { main }

if (require.main === module) {
  process.exit(main())
}
