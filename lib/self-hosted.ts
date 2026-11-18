/**
 * Self-hosted mode (RAD-284).
 *
 * Single source of truth for the `SELF_HOSTED` flag. When on, every feature is
 * unlocked for every local account — no Stripe config, no subscription rows —
 * and the billing surface explains that instead of rendering Checkout buttons
 * against keys that do not exist.
 *
 * This is for MULTI-user self-hosts. A single-user install needs no flag at
 * all: bootstrap the account as ADMIN (scripts/create-user.js --admin) and the
 * existing admin short-circuits apply.
 */
export function isSelfHosted(): boolean {
  // Normalizing guards the flag's worst failure mode: "looks enabled, isn't".
  // A trailing space or TRUE in a compose file must not silently re-enable the
  // paywall.
  const value = process.env.SELF_HOSTED?.trim().toLowerCase()
  return value === "true" || value === "1" || value === "yes" || value === "on"
}
