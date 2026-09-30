# Changelog

Gardener is released as git tags. To move a connected repository to a release, follow
[Upgrading](docs/onboarding.md#upgrading).

## v0.1.7 (2026-09-30)

- `pull_request.open` and `pull_request.open_draft` take optional `labels`, added right after the
  pull request opens, for example a label another workflow looks for. A task that sets them must
  also declare `pull_request.label.add`, whether the labels are written out or filled from an
  earlier step. Every label must already exist, and a resumed run adds only the missing ones.
- Existing repositories: run `upgrade` with this release, then commit and push. The workflows move
  to this release's bridge.

## v0.1.6 (2026-09-30)

- Non-Workers-AI models (`anthropic/…`, `openai/…` and other providers) can go through any AI
  Gateway, including one in another account: `deploy --ai-gateway <account-id>/<gateway-id>
  --ai-gateway-project <name>`, with the token from `GARDENER_AI_GATEWAY_TOKEN`. The token is
  stored only as the runtime Worker's secret. `@cf/…` models stay on the runtime's own account.
  Later `deploy` and `upgrade` runs keep the gateway; `--ai-gateway off` removes it. See
  [AI Gateway](docs/operations.md#ai-gateway).
- A run that cannot reach the gateway, or whose gateway is missing its token, fails with a clear
  message.
- Existing installations: run `deploy` or `upgrade` with this release; the new D1 migration is
  applied automatically. Nothing changes until a gateway is configured. The workflows are
  unchanged.

## v0.1.5 (2026-09-29)

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

## v0.1.4 (2026-09-29)

- Pull requests that touch Gardener's files get a **Check tasks** check. It fails when the
  committed lock or workflows don't match the tasks (a `TASK.md` edited without `generate`), or
  when `.gardener/gardener.json` pins another repository's release, before merge rather than as a
  failed sync afterwards. It runs read-only, with no token and no call to the runtime, so it is
  safe on pull requests from forks. `generate` adds it to `gardener-sync.yml`.
- The Release workflow now checks that every input the generated workflows pass is declared by
  the pinned reusable workflows and bridge actions.
- Existing repositories: run `upgrade` with this release, then commit and push the regenerated
  files.

## v0.1.3 (2026-09-29)

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

## v0.1.2 (2026-09-28)

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

## v0.1.1 (2026-09-28)

- The CLI is published to npm as `@scuffi/gardener`, so `npx @scuffi/gardener generate` works
  without a checkout. Tags stage a release through the Release workflow, and a maintainer
  approves it with 2FA.
- Relicensed under MIT, matching cloudflare/computer.

## v0.1.0 (2026-09-28)

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
