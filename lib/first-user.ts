/**
 * RAD-285 first-account bootstrap.
 *
 * Every account-creation path (credential signup, OAuth) takes this advisory
 * lock inside its transaction before counting users, so a concurrent pair of
 * first signups leaves exactly one ADMIN. The key MUST be identical across all
 * callers — that is why it lives here rather than as a string literal per site.
 *
 * Correctness rests on Prisma's default READ COMMITTED isolation: the waiter
 * acquires the lock only after the winner commits, and its `count()` then takes
 * a fresh snapshot that includes the winner's row. Do not switch these
 * transactions to REPEATABLE READ without re-deriving that argument (the same
 * reasoning is documented for the tracked-question cap in lib/saved/subscription.ts).
 *
 * `_xact_` scoping releases the lock at commit/rollback and is safe under a
 * transaction-mode connection pooler.
 */
export const FIRST_USER_LOCK_KEY = "radaric-first-user"
