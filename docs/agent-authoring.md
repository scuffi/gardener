# Authoring Gardener Agents

## Current status

The strict package format, parser/compiler, Agent-native dashboard, paused drafts, immutable publication, activation/enablement endpoints, and draft-only OAuth MCP boundary exist in the foundation. Git publication automation, CLI packaging, meaningful runtime simulation, and end-to-end Agent execution are not complete. Current simulation is validation-only and cannot execute persistent effects.

## Portable package

An Agent package contains:

```text
AGENT.md
skills/*.md        # optional behavior/reference material
evals/*.yaml       # optional fixtures
evals/*.yml
evals/*.json
```

`AgentSourceV1` preserves each file's exact bytes. Paths are normalized POSIX-relative paths; duplicates, traversal, absolute paths, backslashes, unknown top-level fields, YAML aliases/merge keys, duplicate YAML keys, and missing referenced files fail validation. `AGENT.md` must be UTF-8 Markdown with strict YAML frontmatter.

## Example `AGENT.md`

```markdown
---
schema: gardener.agent/v1
name: PR risk reviewer
description: Reviews opened pull requests and prepares bounded feedback.
triggers:
  - github.pull_request.opened
  - github.pull_request.synchronize
repositories:
  - this
capabilities:
  observation:
    - github.pull_request.read
    - github.comment.read
    - github.check.read
    - github.contents.read
  workspace:
    - workspace.fs.read
    - workspace.git.read
  effects:
    - pull_request.review.submit
authority-ceiling: approval
limits:
  runtime-seconds: 600
  max-turns: 18
  max-tool-calls: 50
  max-tasks: 12
  max-parallel-tasks: 4
  input-tokens: 48000
  output-tokens: 8000
  cost-usd: 1
  operations: 3
  artifact-bytes: 10000000
  retries-per-step: 2
skills:
  - skills/review-guidelines.md
evals:
  - evals/safe-review.yaml
eligibility:
  include-draft-pull-requests: false
  base-branches:
    - main
---

Review the change in parallel by correctness, security, and maintenance risk.
Prefer concrete evidence. If context is incomplete, ask for clarification.
Prepare concise review comments; do not claim that tests ran unless a tool result proves it.
```

The body describes judgment and communication. It cannot grant any authority.

## Strict frontmatter

Required:

- `schema`: exactly `gardener.agent/v1`.
- `name` and `description`.
- `triggers`: one or more exact `RepositoryEventV2` trigger selectors.
- `repositories`: immutable numeric GitHub repository IDs or `this`.

Optional:

- `capabilities`: explicit observation, workspace, and effect arrays. Omitted arrays mean none.
- `authority-ceiling`: `disabled`, `approval`, or `automatic`; default is `approval`. This is a ceiling only and cannot raise instance policy.
- `limits`: runtime, turns, tool calls, tasks, parallel tasks, token/cost, effect count, artifacts, and per-step retries.
- `skills` and `evals`: paths to files included in the same package.
- `eligibility`: numeric event actor IDs, numeric resource-author IDs, label requirements, base branches, and draft-PR inclusion.

`this` is convenience syntax only. Dashboard authoring requires an explicit active repository context (and shows its immutable numeric ID); that context is preserved in provenance. Publication must compile `this` to that one immutable repository ID and fails if it is absent or inactive. It never means every current or future repository.

### Observation capabilities

- `github.repository.metadata.read`
- `github.issue.read`
- `github.pull_request.read`
- `github.comment.read`
- `github.review.read`
- `github.discussion.read`
- `github.check.read`
- `github.contents.read`
- `github.commit.read`
- `github.release.read`

### Workspace capabilities

- `workspace.fs.read`
- `workspace.fs.write`
- `workspace.git.read`
- `workspace.git.write-local`
- `workspace.exec.shell`
- `workspace.exec.javascript`
- `workspace.exec.container`
- `workspace.network.connect`
- `workspace.dependencies.install`
- `workspace.artifacts.publish`

Container, network, and dependency installation are independent. The intended default is **Ask per run** for Container and disabled unrestricted network/dependency installation.

Effect capability names are the exact operation kinds in the [typed operation catalog](#typed-operation-catalog).

## Event triggers

`RepositoryEventV2` covers strict GitHub issue, pull request, issue/PR/review/discussion comments, reviews, discussions, check runs/suites, pushes, and releases, plus trusted manual and scheduled events. A selector joins the event kind and action, for example:

- `github.issue.opened`
- `github.pull_request.ready_for_review`
- `github.pull_request_review.submitted`
- `github.discussion.answered`
- `github.check_run.completed`
- `github.push.pushed`
- `github.release.published`
- `gardener.manual.requested`
- `gardener.scheduled.triggered`

The catalog is versioned. Unknown event actions fail validation. GitHub identities use immutable numeric IDs and account types; login names are display hints. Event actor and resource author are distinct.

## Typed operation catalog

An Agent may only propose operation kinds explicitly listed in its effect capabilities:

- Issues: `issue.label.add`, `issue.label.remove`, `issue.comment.create`, `issue.comment.update`, `issue.close`, `issue.reopen`, `issue.assignee.add`, `issue.assignee.remove`.
- Pull requests: `pull_request.comment.create`, `pull_request.comment.update`, `pull_request.review.submit`, `pull_request.reviewer.request`, `pull_request.reviewer.remove`, `pull_request.update`, `pull_request.open_draft`, `pull_request.merge`.
- Git: `branch.create`, `commit.create`.
- Discussions: `discussion.comment.create`, `discussion.comment.update`, `discussion.answer.mark`, `discussion.answer.unmark`, `discussion.close`, `discussion.reopen`.
- Checks: `check.rerun`.
- Releases: `release.create`, `release.update`, `release.publish`, `release.delete`.

Contracts are strict and bounded. Operations include repository identity and resource-specific expected state such as timestamps, head/base SHAs, draft/state values, required checks, or release/tag facts. Branch creation and commits are restricted to the `gardener/` namespace; PR creation is draft-only. Merge and release publication/deletion are high-impact.

Catalog presence is not proof of deployed execution. Connect currently executes only a subset and returns typed permanent `unsupported_operation` receipts for unimplemented kinds. The complete catalog requires endpoint, permission, webhook, and live-precondition validation before release.

## Lifecycle

```text
mutable paused draft
  → validate and simulate
  → publish immutable paused revision
  → owner activates revision
  → owner separately enables Agent
```

Publication never activates or enables. Activation never changes operation policy. Enablement cannot supply missing capabilities. Agents start disabled, and global/repository pause remains an independent admission control.

A revision records exact source, parsed semantics, compiled repository IDs, supporting-file hashes, provenance, source/semantic/compiled hashes, and compiler/runtime/catalog versions. Every run additionally pins the instance policy/effective capability snapshot and harness adapter version.

## Authoring channels

### Dashboard

The target Agents area supports prompt-to-`AGENT.md`, direct Markdown editing, capability review, safe simulation, publication, revision diffs, activation, and enablement. Inbox is the default operational surface. This new dashboard is not yet integrated.

A prompt may draft behavior and suggest capabilities, but it cannot approve those capabilities. The owner reviews structured capabilities separately.

### Git-native

A package may live in a repository and carry provenance bound to immutable repository ID, commit SHA, and path. Trusted host code must fetch exact bytes through Connect and call the canonical authoring service. A normal Git push does not itself publish, activate, or enable an Agent. Automated Git ingestion remains a blocker.

### CLI

A future CLI may validate, explain, diff, simulate, and save paused drafts through the same API. It must store OAuth credentials outside repositories with owner-only permissions. No completed CLI is shipped in this foundation.

### OAuth MCP

Gardener is the OAuth authorization server, with consent backed by the existing GitHub-authenticated owner session. It uses a stateless `createMcpHandler` surface, not deprecated `McpAgent` state.

Scopes:

- `gardener:agents:read`
- `gardener:agents:validate`
- `gardener:agents:simulate`
- `gardener:agents:drafts:write`
- `gardener:runs:read`

Tools can list/get/catalog/validate/explain/diff/simulate Agents, save a mutable paused draft, and read a bounded redacted trace. They cannot publish an immutable revision, activate, enable, approve, alter policy or repositories, answer authority-bearing interruptions, or execute GitHub effects. MCP simulation is non-mutating. The deployment must provision OAuth storage and finish staging/security validation before advertising this endpoint.

## Runtime capability requests

Safe observation/workspace needs may be requested as typed, expiring one-run interruptions when the catalog and instance policy classify them as grantable. Repository expansion, a new persistent effect, broader actors, or an authority increase requires a new revision. Credentials, policy editing, bypass authority, and unrestricted repository access are never runtime-grantable.

A human response must be authenticated, eligible-responder-bound, nonce-bound, schema-valid, unexpired, and replay-protected. Freeform comments, email, Slack, or model-readable text do not count.
