# Security Policy

## Reporting a vulnerability

Email **inbox@kirillgreen.ru** with a description, reproduction steps and the
affected version/commit — or use GitHub's **private vulnerability reporting**
(Security → Report a vulnerability), which is the faster channel. Please do not
open a public issue for a suspected vulnerability, and do not test against
accounts you do not own.

On a best-effort basis (this is a small project), we aim to acknowledge within
**3 business days** and to give a status update (fix, mitigation, or "won't fix
with reasoning") within **10 business days**. Please give us a reasonable
window to release a fix before public disclosure; we are happy to credit you in
the release notes if you want.

There is no bug-bounty program. Reports are handled on a best-effort basis and
are genuinely appreciated.

## Scope

In scope: authentication and session handling, the subscription/paywall and
entitlement gates, data isolation between users, webhook signature
verification, SSRF and injection in parsers, privilege escalation.

Out of scope: findings that require an already-compromised administrator
account or database, denial of service by brute force without a specific
bypass, missing security headers without a demonstrated impact, and
vulnerabilities in third-party services themselves.

## For self-hosters

Self-hosted instances are operated by their owners, not by us. If you run
Radaric yourself, you are responsible for its secrets (`NEXTAUTH_SECRET`,
database credentials, API keys) and for keeping the image updated. See
[SELF_HOSTING.md](../SELF_HOSTING.md).
