# @scuffi/gardener

Each release is a git tag (`vX.Y.Z`) and the matching `@scuffi/gardener` version on npm. To move a
connected repository to a release, follow [Upgrading](../../docs/onboarding.md#upgrading).

## 0.1.12 (2026-10-07)

### Patch Changes

- 653f893: A repository whose `.github/workflows/gardener-sync.yml` is not Gardener's can name the generated
  sync workflow with `"syncWorkflow": "gardener-<name>.yml"` in `.gardener/gardener.json`. `generate`
  writes the sync workflow there, and `connect` starts that workflow for the first sync. Gardener's
  own repository needs this, because it publishes the reusable workflow at the default path.
  Upgrading: the field is read by this release's sync and check workflows, so upgrade before adding
  it.

## 0.1.11 (2026-10-06)

- Every plan and apply job writes a GitHub job summary. Successful runs list the proposed steps,
  then each applied step with a link. Failed runs lead with what happened and what to do: a task
  limit to raise in TASK.md, a temporary provider or GitHub problem to retry, or a plan that went
  stale because the issue or pull request changed. A stale plan needs **Re-run all jobs**, since
  re-running only the apply job replays the same plan. Each summary ends with the exact
  `gardener runs view` command for the run.
- New effects `pull_request.review_comment.reply` and `pull_request.review_thread.resolve`, so a
  review-fixing task can answer each finding in its own thread and resolve only the threads its
  commit fixed. Both are limited to the pull request that triggered the run.
- Comments, replies and resolves planned after a `commit.create` in the same run now accept the
  head that commit produced. Before, they only passed because GitHub reported the new head a
  couple of seconds late.
- A review that waited behind an earlier round now plans on the pull request's current head, so it
  sees that round's push instead of stopping on a stale checkout. Fork pull requests are unchanged.
- When a repository and its runtime are on different releases, the runtime's refusal names both
  releases and the fix: `gardener upgrade --workspace <name>` with the CLI from the newer release.
- A failed run reports why Gardener refused the model's result, or which check the model's finish
  failed, instead of "Flue task execution failed".
- `max-tool-calls` is documented as including the final `finish_task` call.
- The reusable workflows use `actions/checkout` v7.0.1, `actions/upload-artifact` v7.0.1 and
  `actions/download-artifact` v8.0.1, which run on Node 24.
- Upgrading: deploy the runtime first (`gardener upgrade` does), then commit and push the upgraded
  repository. An older runtime refuses tasks that use the new effects.

## 0.1.10 (2026-10-01)

- `authors` can be a list of exact GitHub logins, optionally with `maintainers`, such as
  `[maintainers, "devin-ai-integration[bot]"]`, so a task can respond to a review bot. Logins
  match case-insensitively. Quote `[bot]` logins inside a bracketed YAML list.
- New `opened-by` trigger filter: exact logins of who opened the issue, pull request or discussion,
  such as `["github-actions[bot]"]` for pull requests Gardener opened. It works on comment, review,
  label and state triggers, and the generated workflow prefilters it.
- New top-level `checkout: pull-request-head`, so a task can push a commit onto an existing pull
  request's branch. Such tasks run one at a time per pull request.
- Together these let a task answer reviews on its own pull requests in rounds: fix what the review
  found, push one commit, reply, and stop after a set number of rounds. A review starts a run only
  once the pull request's merge ref contains the task's workflow, so update the branch of a pull
  request opened before the task was added.
- `init` and `generate` write `.gardener/SKILL.md`, a guide to the task format for coding agents,
  matching the CLI's version.
- Upgrading: deploy the runtime first (`gardener upgrade` does), then commit and push the upgraded
  repository. An older runtime refuses tasks that use the new fields.

## 0.1.9 (2026-10-01)

- Long runs no longer fail with "Subrequest depth limit exceeded". The task agent now pushes its
  result and settlement to the run's session. The session no longer polls the agent while serving
  the agent's tool calls, a loop that deepened the request chain on every tool call until Cloudflare
  refused it. If a pushed settlement is lost, the session checks on the agent itself after three
  quiet minutes.
- A run's tool calls no longer load every earlier result into memory, which could exhaust the
  runtime's memory on long runs with large command output.
- The plan step's `max-reconnects` now counts only consecutive failed reconnects. The count starts
  again after a connection that stayed up for 30 seconds, and a run allows 50 reconnects in total.
- Upgrading: deploy the runtime first (`gardener upgrade` does), then commit and push the upgraded
  repository. The runtime fix applies as soon as it is deployed, even before a repository moves to
  this release.

## 0.1.8 (2026-09-30)

- Tasks set their own limits. Gardener no longer caps `max-turns`, `max-tool-calls`, `input-tokens`
  or `output-tokens`; it keeps only the minimums a run needs. `runtime-seconds` may go up to 21,000,
  since a GitHub-hosted job runs for at most 6 hours.
- The plan job's timeout is now the task's `runtime-seconds` plus 10 minutes, rather than a fixed
  10 minutes.
- Each model request asks for no more output than its model produces (32,000 tokens for gateway
  models the catalog does not list), however large `output-tokens` is.
- AI Gateway model calls that fail with a network error, HTTP 429 or a 5xx are retried twice, with
  backoff, before the run fails. A retry can be billed by the provider, so `output-tokens` bounds the
  run rather than the exact spend.
- Upgrading: deploy the runtime first (`gardener upgrade` does), then commit and push the upgraded
  repository. A 0.1.7 runtime refuses tasks over the old limits. Generating with 0.1.8 in a
  repository still pinned to an earlier release leaves the timeout out, and warns about tasks over
  480 seconds.

## 0.1.7 (2026-09-30)

- `pull_request.open` and `pull_request.open_draft` take optional `labels`, added right after the
  pull request opens, for example a label another workflow looks for. A task that sets them must
  also declare `pull_request.label.add`, whether the labels are written out or filled from an
  earlier step. Every label must already exist, and a resumed run adds only the missing ones.
- Existing repositories: run `upgrade` with this release, then commit and push. The workflows move
  to this release's bridge.

## 0.1.6 (2026-09-30)

- Non-Workers-AI models (`anthropic/…`, `openai/…` and other providers) can go through any AI
  Gateway, including one in another account: `deploy --ai-gateway <account-id>/<gateway-id>
  --ai-gateway-project <name>`, with the token from `GARDENER_AI_GATEWAY_TOKEN`. The token is
  stored only as the runtime Worker's secret. `@cf/…` models stay on the runtime's own account.
  Later `deploy` and `upgrade` runs keep the gateway; `--ai-gateway off` removes it. See
  [AI Gateway](../../docs/operations.md#ai-gateway).
- A run that cannot reach the gateway, or whose gateway is missing its token, fails with a clear
  message.
- Existing installations: run `deploy` or `upgrade` with this release; the new D1 migration is
  applied automatically. Nothing changes until a gateway is configured. The workflows are
  unchanged.

## 0.1.5 (2026-09-29)

- Runs are no longer refused between an upgrade merging and its sync landing: the runtime also
  accepts task workflows from the release it was deployed from.
- Each run records its tool calls. `runs view` lists every call with its status and a short
  target (a file path or API route, never command text), and `task.settled` totals the calls and
  proposals. A failed run's Actions error now ends with those totals, for example
  `(16 tool calls: 9 repository.read_file, 7 provider.api.read; no effects proposed)`.
- `upgrade` moves `package.json` scripts that run a pinned `@scuffi/gardener`, such as
  `gardener:generate`, to the new release.
- `connect` starts the sync workflow on the default branch when it is there, so a repository
  merged before connecting gets a green sync.
- `--help` lists `connect`, `repositories`, `repository disable|enable` and `tasks`.
- Existing repositories: run `upgrade` with this release, then commit and push `package.json` if
  it changed. The workflows are unchanged.

## 0.1.4 (2026-09-29)

- Pull requests that touch Gardener's files get a **Check tasks** check. It fails when the
  committed lock or workflows don't match the tasks (a `TASK.md` edited without `generate`), or
  when `.gardener/gardener.json` pins another repository's release, before merge rather than as a
  failed sync afterwards. It runs read-only, with no token and no call to the runtime, so it is
  safe on pull requests from forks. `generate` adds it to `gardener-sync.yml`.
- The Release workflow now checks that every input the generated workflows pass is declared by
  the pinned reusable workflows and bridge actions.
- Existing repositories: run `upgrade` with this release, then commit and push the regenerated
  files.

## 0.1.3 (2026-09-29)

- Tasks go live when they reach the default branch. `generate` adds a `gardener-sync.yml`
  workflow that sends the compiled tasks to the runtime on every push to the default branch that
  touches Gardener's files: new tasks start running, and deleted or drafted tasks stop. `connect`
  is only needed once per repository. The runtime accepts a sync only from Gardener's pinned sync
  workflow, on the default branch, at the repository's release or the one the Worker runs
  (migration `0003_actions_repository_syncs`).
- If the committed files are stale (someone edited a `TASK.md` without running `generate`), the
  sync fails and the previous tasks keep running.
- Removed `task enable` and `task disable`. To stop a task, delete it or set `draft: true`. To
  stop everything, `gardener repository disable`.
- `upgrade` no longer enrols the repository. Commit and push the regenerated files; the sync
  enrols them.
- A comment author with write or admin access to the repository now counts as a maintainer, even
  if their organisation membership is private. Read-only members still need public membership.
- Existing repositories: run `upgrade` with this release, then commit and push the regenerated
  files.

## 0.1.2 (2026-09-28)

- The CLI keeps no local state. It finds an installation by its `gardener-<workspace>` name on the
  Cloudflare account, and `deploy` records the runtime URL, CLI version and deployment digest in
  the workspace's D1 (migration `0002_actions_installation`). Any operator with access to the
  account can run every command.
- `deploy` adopts existing `gardener-<workspace>` resources, and refuses to replace a runtime
  deployed by a newer CLI.
- Removed `rollback` and `down`. To go back, release a revert. To remove an installation, delete
  its Worker and D1 database in the Cloudflare dashboard.
- `connect` no longer rewrites `GARDENER_RUNTIME_URL` when it is already correct.
- Installations from v0.1.1 or earlier must run `upgrade` or `deploy` once with this release
  before other commands work.

## 0.1.1 (2026-09-28)

- The CLI is published to npm as `@scuffi/gardener`, so `npx @scuffi/gardener generate` works
  without a checkout. Tags stage a release through the Release workflow, and a maintainer
  approves it with 2FA.
- Relicensed under MIT, matching cloudflare/computer.

## 0.1.0 (2026-09-28)

First internal preview.

- Tasks are defined in `.gardener/tasks/*/TASK.md`. Each runs as its own GitHub Actions workflow:
  planning is unprivileged, and apply executes only the exact, hash-bound plan.
- Effects cover issues (create, comment, label, assign, close), pull requests (open, review,
  comment, label, update, close, merge gated on named checks, and rebase or merge the base in
  through GitHub), branches and commits (limited by branch patterns), discussions, and releases.
- Triggers can filter on labels, branches, mentions and comment authors, or run on a
  schedule.
- Each task can set its model and limits (runtime, turns, tool calls, tokens).
- Refused proposals and failed tool calls are recorded in the run's audit trail (`runs view`).
- CLI commands: `init`, `generate`, `deploy`, `upgrade`, `yolo`, `doctor`, `debug`, `runs`, and
  `runs view`. The kill switches (`task` and `repository` `enable|disable`) still work but are
  not listed in `--help`.
- Starter tasks in `examples/tasks/`: `triage`, `pr-review`, `mention-reply`.
