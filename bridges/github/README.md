# Gardener GitHub bridge

This bridge is the GitHub-hosted execution adapter for Gardener. It is not a separate service.

- `plan/` runs in the unprivileged checkout job, authenticates to the customer-deployed Gardener runtime with GitHub OIDC, and executes bounded repository inspection actions.
- `apply/` runs in the checkout-free effects job, verifies the exact plan artifact, applies the permitted effect with the job-scoped `GITHUB_TOKEN`, and records the receipt with the runtime.

The reusable two-job workflow lives at `.github/workflows/gardener-task.yml` because GitHub requires reusable workflows directly under `.github/workflows`.

Both bridge Actions are committed as prebuilt Node.js bundles and must be consumed at full commit SHAs.
