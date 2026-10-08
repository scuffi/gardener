---
"@scuffi/gardener": patch
---

`connect`, `deploy` and the other commands that write to the Gardener database now pass their SQL to
Wrangler in a file rather than as an argument. Enrolment SQL carries whole task bundles, so it could
pass Windows' command-line limit, and some endpoint security tools kill processes started with very
long arguments.
