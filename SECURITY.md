# Security policy

Shutro holds business data: accounts, invoices, payments, people. Security reports get priority.

## Supported versions

Shutro is in its 0.x series. Security fixes go into the latest published `0.x` release; please upgrade to it.

## Reporting a vulnerability

Please **do not** open a public issue. Instead:

1. Use GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability**, or
2. email **hmisahaq01@gmail.com** with the subject `SECURITY: shutro`.

Include what you found, how to reproduce it (a model definition and the calls, or the HTTP requests), the impact you
see (for example "a user without access to `account.move` can read invoices"), and the version.

You can expect an acknowledgement within 3 working days and an assessment within 10. Once a fix is released, the
advisory credits you unless you prefer otherwise.

## Scope

In scope: the ORM's access control (ACL, record rules, field groups, row-level security), SQL injection, the
`@shutro/server` API (sign-in, sessions, CSRF, authorization), the audit trail's integrity, encrypted fields, and the
CLI's handling of credentials.

Out of scope: vulnerabilities that need an already-compromised database superuser or server host, denial of service
by unbounded legitimate load, and issues in applications built on Shutro (report those to their authors).
