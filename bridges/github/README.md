# GitHub bridge

The two Node.js Actions that run inside Gardener's reusable workflow
(`.github/workflows/gardener-task.yml`).

- `plan/` runs in the read-only checkout job. It authenticates to the Gardener Worker with GitHub
  OIDC, runs the task's tool calls in the checkout, captures proposed file changes, and writes the
  plan artifact.
- `apply/` runs in the checkout-free job. It verifies the plan artifact, applies each operation
  with the job's `GITHUB_TOKEN`, and reports receipts to the Worker.

`dist/index.cjs` in each directory is built from `packages/runner` with
`pnpm --filter @gardener/runner build` and committed. `pnpm check:bridge-dist` fails if the
committed bundles differ from source. Consume both Actions only at full commit SHAs.
