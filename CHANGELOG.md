# Changelog

Gardener is released as git tags. To move a connected repository to a release, follow
[Upgrading](docs/onboarding.md#upgrading).

## v0.1.1 (2026-09-28)

- The CLI is published to npm as `@scuffi/gardener`, so `npx @scuffi/gardener generate` works
  without a checkout. Tags publish automatically through the Release workflow.
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
