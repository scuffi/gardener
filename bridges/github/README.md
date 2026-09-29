# GitHub bridge

The Node.js Actions that run inside Gardener's reusable workflows.

- `plan/` and `apply/` run in `.github/workflows/gardener-task.yml`.
- `plan/` runs in the read-only checkout job. It authenticates to the Gardener Worker with GitHub
  OIDC, runs the task's tool calls in the checkout, captures proposed file changes, and writes the
  plan artifact.
- `apply/` runs in the checkout-free job. It verifies the plan artifact, applies each operation
  with the job's `GITHUB_TOKEN`, and reports receipts to the Worker.

- `sync/` runs in `.github/workflows/gardener-sync.yml` after a push to the default branch. It
  compiles the committed tasks, refuses stale generated files, and enrolls the tasks with the
  Worker using GitHub OIDC. In `.github/workflows/gardener-check.yml` it runs with `mode: check`
  on pull requests, and only reports stale generated files.

`plan/` and `apply/` are built from `packages/runner` with `pnpm --filter @gardener/runner build`,
and `sync/` from `packages/cli` with `pnpm --filter @scuffi/gardener build`. The bundles are
committed. `pnpm check:bridge-dist` fails if they differ from source. Consume the Actions only at
full commit SHAs.
