# Architecture

Gardener is split along one line: GitHub Actions does everything that touches GitHub, and the
Worker decides what is allowed to happen.

| Owned by GitHub Actions | Owned by Gardener |
| --- | --- |
| Triggers and event delivery | Task compilation and enrollment |
| Checkout | Model orchestration (Flue on Workers AI) |
| Token permissions | Proposal validation and plan construction |
| Every GitHub API call | Run state, receipts, and audit history |

## Components

```text
Operator machine                    Cloudflare account
└── gardener CLI ──deploy/enroll──► Worker
                                    ├── TaskRunnerSession (Durable Object, one per job)
                                    ├── FlueGardenerTaskHarnessAgent (Durable Object)
                                    ├── Workers AI
                                    └── D1

Customer repository
├── .gardener/tasks/*/TASK.md
└── .github/workflows/gardener-<task>.yml
      └── scuffi/gardener/.github/workflows/gardener-task.yml@<sha>
            ├── plan job  ── bridges/github/plan@<sha>
            └── apply job ── bridges/github/apply@<sha>
```

- **CLI** (`packages/cli`) compiles tasks, generates workflows, deploys the Worker, and enrolls
  repositories. It is the only component that uses Cloudflare or `gh` credentials.
- **Worker** (`apps/gardener`) serves `GET /health` and `/session/<id>`. Sessions use Cap'n Web
  over WebSocket, and each job gets its own `TaskRunnerSession`.
- **GitHub bridge** (`packages/runner`, built into `bridges/github`) is a pair of Node.js Actions
  that run inside the workflow jobs. The plan bridge executes tool calls for the Worker. The apply
  bridge executes the validated plan against the GitHub API.
- **Reusable workflow** (`.github/workflows/gardener-task.yml`) defines the two jobs, and each
  generated caller workflow invokes it at a full commit SHA.

## Tasks

`TASK.md` is an authoring format. `gardener build` compiles each task into canonical `TaskBundleV1`
JSON. It records the bundle's SHA-256 in `.gardener/gardener.lock.json` and writes one caller
workflow per task. `gardener connect` then does three things:

1. uploads the bundles to D1;
2. enables those exact hashes for the repository's numeric ID;
3. sets the non-secret `GARDENER_RUNTIME_URL` repository variable.

The caller workflow passes the bundle hash to the reusable workflow. The Worker loads the bundle
by hash, recomputes the digest, and refuses anything not enabled for the authenticated repository.
Editing a task therefore takes effect only after it is rebuilt and reconnected.

Every bundle contains the manual trigger, so every task can be run by hand. A bundle that sets
`draft: true` is manual-only: its workflow listens only for manual runs, and the runtime refuses any
other event for it.

## Plan phase

```text
plan job                                   Worker
────────                                   ──────
checkout (persist-credentials: false)
request OIDC token (aud = Worker origin)
open /session/<repo>-<run>-<attempt>-plan ─► verify OIDC claims and enrollment
send normalized event                     ─► load bundle, match trigger
                                             start Flue agent (Workers AI)
                                     ◄─ tool call: list_files / read_file / exec / api read
run tool in checkout, return result      ─►
                                     ◄─ capture request (only if a commit is proposed)
build change manifest + artifact         ─►
                                             validate proposals, build ordered plan
                                     ◄─ exact plan + SHA-256
upload plan (and capture) artifacts
```

The event is normalized by the bridge and bound into the run. The Worker receives the facts that
later preconditions depend on, such as resource state, `updated_at`, and head SHA. Apply
re-verifies every one of them against live GitHub.

The model works through two tools:

- `propose_effect(stepName, kind, payloadJson, referencesJson, rationale)` adds one step;
- `finish_task` ends the run.

For each declared kind, the prompt includes a compact JSON Schema of the payload. The Worker
validates every proposal as it arrives and sends the error message back to the model on rejection.

A plan is an ordered list of steps. Each step holds one exact operation, which is one of the 29
`OperationKind` values. A step can reference named scalar outputs of earlier steps, for example
the `commitSha` from a `commit.create` feeding a `pull_request.open_draft`. The Worker assigns
every operation ID and computes the plan digest over canonical JSON.

## Apply phase

The apply job starts only if the plan job produced a plan, and it has no checkout. It runs these
steps:

1. Download the plan artifact, and the capture artifact if there is one.
2. Verify the plan's SHA-256 against the plan job's output.
3. Authenticate as the effects phase and confirm the plan with the Worker.
4. For each step:
   1. resolve its references from earlier receipts;
   2. add the trusted idempotency marker;
   3. check the step's preconditions;
   4. perform the operation;
   5. report the receipt.
5. Stop at the first failure or conflict.

Commits go through the Git Data API. The executor builds the new tree from the capture artifact one
blob at a time, re-verifying each file's size and digest before uploading it.

Each step's preconditions carry the resource state seen at planning. So that a plan can write the
same issue, pull request, or discussion twice, apply reads the resource back after a verified write
whenever a later step may target it, and records the new `updated_at` in the step receipt. A later
step on that resource accepts either value. Releases and comments are not chained, so a second write
to one of them in the same plan conflicts.

If a step cannot become a valid operation with the values earlier steps produced, for example a
placeholder value longer than its type allows, apply records it as a terminal conflict and stops.

Receipts are stored per step. A re-run of the apply job skips steps whose receipts match exactly
and continues from the first incomplete step. A conflict, meaning GitHub state that changed since
planning, is terminal.

## Data

D1 is the only store. It holds six tables:

| Table | Contents |
| --- | --- |
| `actions_repository_enrollments` | Numeric repository and owner IDs, pinned plan/effects workflow references, OIDC audience, enabled flag |
| `actions_task_bundles` | Canonical bundles keyed by SHA-256 |
| `actions_repository_tasks` | Which bundle hashes are enabled for which repository |
| `actions_task_runs` | One row per run, attempt, and phase: status, request, model outcome, effect receipt |
| `actions_task_audit` | Append-only run events (update and delete are blocked by triggers) |
| `actions_control_audit` | Record of repository and task enable/disable changes, written by triggers |

The schema is a single migration, `apps/gardener/migrations/0001_actions_baseline.sql`.

## Releases and pinning

A release is three linked commits:

1. the bridge build under `bridges/github`;
2. the reusable workflow, pinning the bridge by SHA;
3. the CLI, whose `DEFAULT_WORKFLOW_REF` pins the reusable workflow by SHA.

Generated workflows record the pin, and the Worker requires the OIDC `job_workflow_ref` to match
the pin enrolled for the repository. Existing repositories keep their pin until
`gardener upgrade` moves them explicitly.

`scripts/check-bridge-dist.mjs` rebuilds the bridge and fails if the committed bundle differs from
source.

## Runtime dependencies

The model runtime is Flue `2.0.3`, with `@earendil-works/pi-ai` `0.83.0`. Every model call goes
through the Workers AI binding to the account's AI Gateway named `default`. Each bundle names its
model; `gardener build` writes `@cf/moonshotai/kimi-k2.6` when a task names none. Dependencies
are pinned exactly. `pnpm versions:check` reports drift from the latest npm releases, and any
intentionally held version is listed in `scripts/check-versions.mjs`.
