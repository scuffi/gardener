# Actions v1 exact-effect qualification

These workflows exercise the released effects Action without exposing a write-capable GitHub token to repository shell execution.

- `effects-negative.yml` runs on an issue opened with `gardener-negative`. It creates artifacts in trusted workflow shell steps, then passes the token only to the pinned effects Action. Digest, repository, and issue mismatches must all fail, and the issue must retain zero comments.
- `effects-reconcile-reusable.yml` plans one real effect, executes the exact artifact twice in a checkout-free effects job, and requires both executions to return the same operation and comment IDs. The issue, D1 receipt, and audit log must each show one effect.

The reconciliation workflow must be committed first and invoked by a caller pinned to that full commit SHA. Temporarily enroll that exact reusable-workflow reference, run qualification, and restore the product enrollment even when qualification fails. The accepted live evidence and exact pins are recorded in `../LIVE-QUALIFICATION.md`.
