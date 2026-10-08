# Task reference

Everything a task and its project can declare, and what Gardener generates from them. For how to
write a task, see [Creating tasks](task-authoring.md). Tables marked *generated* are produced from
the code, and `pnpm check` fails if they fall out of date.

## Files

```text
.gardener/
  gardener.json            project settings
  gardener.lock.json       generated: compiled bundles and their hashes
  SKILL.md                 generated: a task-writing guide for coding agents
  tasks/<dir>/TASK.md      one task per directory
.github/workflows/
  gardener-<id>.yml        generated: one caller workflow per task
  gardener-sync.yml        generated: syncs tasks from the default branch, checks pull requests
```

`gardener init` creates the project; `gardener generate` writes every generated file. Never edit a
generated file: the sync and the pull request check both fail if one differs from what `generate`
produces. `generate` refuses to overwrite a workflow it did not write.

### `gardener.json`

| Key | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | `gardener.project/v1`. |
| `target` | yes | `github-actions/v1`, the only target. |
| `release.workflowRef` | yes | The Gardener release this project uses: `scuffi/gardener/.github/workflows/gardener-task.yml@<commit>`. Set by `init` and moved by `upgrade`. |
| `handle` | no | The GitHub handle people @mention to reach this project's tasks, without `@`. `mentions: [self]` resolves to it. Pick one that is not a real account (`gh api users/<name>` should return 404), or every mention also notifies that person. |
| `syncWorkflow` | no | The generated sync workflow's file name, when `gardener-sync.yml` is taken: a `gardener-*.yml` name of at most 64 characters. |

A key this release does not know fails with a message to upgrade: the sync and check workflows run
the pinned release's parser.

## `TASK.md`

YAML frontmatter followed by a Markdown body. The body is the model's instructions; it cannot grant
tools, effects, network access or permissions.

| Key | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | `gardener.task/v1`. |
| `id` | yes | Immutable identity, independent of the directory: lowercase letters, digits, `.`, `_` and `-`, up to 160 characters. Names the workflow `gardener-<id>.yml`. |
| `name` | yes | Display name, up to 100 characters. |
| `description` | yes | Up to 1,000 characters. |
| `trigger` or `triggers` | exactly one | One trigger, or a list. See [Triggers](#triggers). |
| `tools` | yes | At least one. See [Tools](#tools). |
| `effects` | no | What the task may change. Omit or `[]` for a read-only task. See [Effects](#effects). |
| `network` | yes | Egress posture. See [Network](#network). |
| `limits` | yes | Run budget. See [Limits](#limits). |
| `model` | no | Model ID. Defaults to `"@cf/zai-org/glm-5.3"`. See [Model](#model). |
| `draft` | no | `true` makes the task run only by hand. |
| `checkout` | no | `pull-request-head` checks out the pull request's head instead of GitHub's merge preview. Needs a pull request trigger. Implied when a `commit.create` entry lists `branches` other than `gardener/**`. |
| `reactions` | no | `false` turns off the 👀 → 🚀/😕 reactions. On by default. See [Reactions](#reactions). |

## Triggers

Each trigger is an `event` plus the filters its kind accepts. A task may use each kind at most once.
Every task can also be run by hand: `generate` adds `github.workflow_dispatch` when it is not
declared. Using a filter a kind does not accept is a compile error.

<!-- generated:triggers -->
| Kind | Filters |
| --- | --- |
| `github.issue.opened` | `labels-all`, `mentions`, `authors` |
| `github.issue.edited` | `labels-all`, `mentions`, `authors` |
| `github.issue.labeled` | `labels-all`, `opened-by` |
| `github.issue.unlabeled` | `labels-all`, `opened-by` |
| `github.issue.reopened` | `labels-all`, `opened-by` |
| `github.issue_comment.created` | `labels-all`, `mentions`, `authors`, `opened-by` |
| `github.issue_comment.edited` | `labels-all`, `mentions`, `authors`, `opened-by` |
| `github.pull_request.opened` | `labels-all`, `mentions`, `authors` |
| `github.pull_request.reopened` | `labels-all`, `opened-by` |
| `github.pull_request.synchronize` | `labels-all`, `opened-by` |
| `github.pull_request.ready_for_review` | `labels-all`, `opened-by` |
| `github.pull_request.converted_to_draft` | `labels-all`, `opened-by` |
| `github.pull_request.edited` | `labels-all`, `mentions`, `authors` |
| `github.pull_request.labeled` | `labels-all`, `opened-by` |
| `github.pull_request.unlabeled` | `labels-all`, `opened-by` |
| `github.pull_request_review.submitted` | `labels-all`, `mentions`, `authors`, `opened-by` |
| `github.pull_request_review_comment.created` | `labels-all`, `mentions`, `authors`, `opened-by` |
| `github.pull_request_review_comment.edited` | `labels-all`, `mentions`, `authors`, `opened-by` |
| `github.push` | `branches` (required) |
| `github.workflow_dispatch` | none |
| `github.schedule` | `cron` (required) |
| `github.discussion.created` | `labels-all`, `mentions`, `authors` |
| `github.discussion.edited` | `labels-all`, `mentions`, `authors` |
| `github.discussion.answered` | `labels-all`, `opened-by` |
| `github.discussion.unanswered` | `labels-all`, `opened-by` |
| `github.discussion.labeled` | `labels-all`, `opened-by` |
| `github.discussion.unlabeled` | `labels-all`, `opened-by` |
| `github.discussion_comment.created` | `labels-all`, `mentions`, `authors`, `opened-by` |
| `github.discussion_comment.edited` | `labels-all`, `mentions`, `authors`, `opened-by` |
<!-- /generated:triggers -->

| Filter | Meaning |
| --- | --- |
| `labels-all` | Every listed label must be on the issue, pull request or discussion. Up to 20. |
| `mentions` | The text must @mention one of these handles; `self` is the project's `handle`. Whole-handle and case-insensitive. On comment triggers the text is the comment, on `pull_request_review.submitted` the review, otherwise the issue, pull request or discussion body. On an `.edited` trigger, only an edit that adds a mention counts. |
| `authors` | Who may have written the text: `maintainers`, `any`, or a list of logins that may include `maintainers`. `maintainers` is the owner, organization members and collaborators, or anyone with write or admin access. The default is `maintainers` for comment triggers, `pull_request_review.submitted`, and any trigger with `mentions`; otherwise `any`. |
| `opened-by` | Exact logins that opened the thread the event belongs to, such as `["dependabot[bot]"]`. |
| `branches` | Branch patterns a push must match. Required on `github.push`. |
| `cron` | A five-field cron expression. Required on `github.schedule`. A task has at most one. |

Pull request events from forks never run, and `pull_request_target` cannot be declared. Manual runs
ignore `labels-all`, `mentions` and `authors`.

## Tools

| Tool | Meaning |
| --- | --- |
| `repository.list_files` | List files in the checkout. |
| `repository.read_file` | Read a file in the checkout. |
| `repository.exec` | Run shell commands in the checkout, with unrestricted network access. See [Network](#network). |
| `provider.api.read` | Read the GitHub API: REST `GET`/`HEAD` and GraphQL queries. |

No tool ever holds a token that can write. `provider.api.read` is served by the bridge; its token is
never shown to the model or to commands.

## Effects

`effects` lists the exact operations a task may propose. Each entry is a kind, a family glob, or a
kind with options. Every declared effect is applied automatically, with no approval step.

<!-- generated:families -->
| Glob | Expands to |
| --- | --- |
| `check.*` | `check.rerun` |
| `discussion.*` | `discussion.comment.create`, `discussion.comment.update`, `discussion.answer.mark`, `discussion.answer.unmark`, `discussion.close`, `discussion.reopen` |
| `git.*` | `branch.create`, `commit.create` |
| `issue.*` | `issue.label.add`, `issue.label.remove`, `issue.comment.create`, `issue.comment.update`, `issue.close`, `issue.reopen`, `issue.assignee.add`, `issue.assignee.remove`, `issue.create` |
| `pull_request.*` | `pull_request.comment.create`, `pull_request.comment.update`, `pull_request.review.submit`, `pull_request.reviewer.request`, `pull_request.reviewer.remove`, `pull_request.update`, `pull_request.label.add`, `pull_request.label.remove`, `pull_request.update_branch`, `pull_request.review_comment.reply`, `pull_request.review_thread.resolve`, `pull_request.open`, `pull_request.open_draft`, `pull_request.merge` |
| `release.*` | `release.create`, `release.update`, `release.publish`, `release.delete` |
<!-- /generated:families -->

A family glob grants every current and future member of its family. Prefer exact kinds: `git.*`,
`pull_request.*` (which includes `pull_request.merge`), `release.*` (which includes
`release.delete`) and `check.*` all grant more than most tasks need.

<!-- generated:effects -->
| Kind | Does | Write scopes | Outputs |
| --- | --- | --- | --- |
| `issue.label.add` | Add an existing label to an issue. | `issues` | `issueNumber`, `label` |
| `issue.label.remove` | Remove a label from an issue. | `issues` | `issueNumber`, `label` |
| `issue.comment.create` | Comment on an issue. | `issues` | `commentId`, `commentUrl`, `issueNumber` |
| `issue.comment.update` | Edit a comment on an issue. | `issues` | `commentId`, `commentUrl`, `issueNumber` |
| `issue.close` | Close an issue. | `issues` | `issueNumber`, `issueUrl`, `state` |
| `issue.reopen` | Reopen an issue. | `issues` | `issueNumber`, `issueUrl`, `state` |
| `issue.assignee.add` | Assign someone to an issue. | `issues` | `assigneeId`, `assigneeLogin`, `issueNumber` |
| `issue.assignee.remove` | Unassign someone from an issue. | `issues` | `assigneeId`, `assigneeLogin`, `issueNumber` |
| `issue.create` | Open an issue, optionally with labels and assignees. | `issues` | `issueNumber`, `issueUrl` |
| `pull_request.comment.create` | Comment on a pull request's conversation. | `pull-requests` | `commentId`, `commentUrl`, `pullNumber` |
| `pull_request.comment.update` | Edit a comment on a pull request's conversation. | `pull-requests` | `commentId`, `commentUrl`, `pullNumber` |
| `pull_request.review.submit` | Submit a review, optionally with line comments. | `pull-requests` | `pullNumber`, `reviewId`, `reviewState`, `reviewUrl` |
| `pull_request.reviewer.request` | Request reviewers. | `pull-requests` | `pullNumber` |
| `pull_request.reviewer.remove` | Remove requested reviewers. | `pull-requests` | `pullNumber` |
| `pull_request.update` | Change a pull request's title, body, state or draft status. | `pull-requests` | `draft`, `pullNumber`, `pullUrl`, `state`, `title` |
| `pull_request.label.add` | Add an existing label to a pull request. | `pull-requests` | `label`, `pullNumber` |
| `pull_request.label.remove` | Remove a label from a pull request. | `pull-requests` | `label`, `pullNumber` |
| `pull_request.update_branch` | Update a pull request with its base, by rebase or merge. | `contents`, `pull-requests` | `pullNumber` |
| `pull_request.review_comment.reply` | Reply in a review thread on the triggering pull request. | `pull-requests` | `commentId`, `commentUrl`, `pullNumber` |
| `pull_request.review_thread.resolve` | Resolve a review thread on the triggering pull request. | `pull-requests` | `pullNumber`, `threadId` |
| `branch.create` | Create a branch. | `contents` | `branch`, `branchUrl`, `commitSha`, `ref` |
| `commit.create` | Commit the files the task changed in its checkout. | `contents` | `branch`, `commitSha`, `commitUrl`, `parentSha`, `treeSha` |
| `pull_request.open` | Open a pull request, ready for review. | `pull-requests` | `baseRef`, `headRef`, `headSha`, `pullNodeId`, `pullNumber`, `pullUrl` |
| `pull_request.open_draft` | Open a draft pull request. | `pull-requests` | `baseRef`, `headRef`, `headSha`, `pullNodeId`, `pullNumber`, `pullUrl` |
| `pull_request.merge` | Merge a pull request after verifying its checks. | `contents`, `pull-requests` | `mergeCommitSha`, `pullNumber`, `pullUrl` |
| `discussion.comment.create` | Comment on a discussion. | `discussions` | `commentId`, `commentNodeId`, `commentUrl`, `discussionNumber` |
| `discussion.comment.update` | Edit a comment on a discussion. | `discussions` | `commentId`, `commentNodeId`, `commentUrl`, `discussionNumber` |
| `discussion.answer.mark` | Mark a comment as the discussion's answer. | `discussions` | `answerCommentId`, `discussionNumber` |
| `discussion.answer.unmark` | Unmark a discussion's answer. | `discussions` | `answerCommentId`, `discussionNumber` |
| `discussion.close` | Close a discussion. | `discussions` | `discussionNumber`, `discussionUrl`, `state` |
| `discussion.reopen` | Reopen a discussion. | `discussions` | `discussionNumber`, `discussionUrl`, `state` |
| `check.rerun` | Re-run a GitHub Actions check run. | `checks` | `checkRunId`, `headSha`, `status` |
| `release.create` | Create a release. | `contents` | `draft`, `prerelease`, `releaseId`, `releaseUrl`, `tagName` |
| `release.update` | Edit a release. | `contents` | `draft`, `prerelease`, `releaseId`, `releaseUrl`, `tagName` |
| `release.publish` | Publish a draft release. | `contents` | `draft`, `prerelease`, `releaseId`, `releaseUrl`, `tagName` |
| `release.delete` | Delete a release. | `contents` | `releaseId`, `tagName` |
<!-- /generated:effects -->

A step can use an earlier step's outputs, either as a whole field or as `{{name}}` placeholders in
text. See [Using one step's result in a later step](task-authoring.md#using-one-steps-result-in-a-later-step).

### Branches

`branch.create`, `commit.create`, `pull_request.open` and `pull_request.open_draft` may only use
branches under `gardener/` unless their entry lists `branches`:

```yaml
effects:
  - kind: commit.create
    branches: ["gardener/**", "docs/*"]
```

The list replaces the default. `*` matches within one path segment and `**` one or more whole
segments. A pattern never matches the default branch; name it exactly to allow it. Quote patterns in
YAML.

### Effect behaviour

- **Labels and assignees** must already exist or be assignable. If GitHub drops one, the step fails
  and names it.
- **`issue.create`** marks the issue it opens, so a resumed run finds it among the 500 newest issues
  and pull requests instead of opening a second one.
- **`pull_request.open` and `.open_draft`** can take up to ten `labels`, which needs
  `pull_request.label.add` too.
- **`pull_request.update_branch`** brings a pull request up to date with its base, by `rebase` or
  `merge`, only if the head is the one the task saw. It stops on conflicts.
- **`pull_request.review_comment.reply` and `.review_thread.resolve`** act only on the pull request
  that triggered the run.
- **`commit.create`** commits the files the task changed in its checkout, on a branch that points at
  the checked-out commit. After it pushes to a pull request's branch, later comment, reply and
  resolve steps in the same plan accept the new head.
- **`pull_request.merge`** verifies exactly the checks the step lists before merging.
- **Every step** checks the state it was planned against (a head SHA, an issue state, an update
  time) and refuses if it changed. Apply stops at the first failed step and resumes from it.

### Protected paths

A committed change may not write under `.git/`, `.github/workflows/`, `.github/actions/` or
`.gardener/`, nor any `CODEOWNERS` file or `.github/dependabot.yml`/`.yaml`, so a run can never
rewrite what governs the next run.

## Network

| Task | Required `network` |
| --- | --- |
| Declares `repository.exec` | `default: allow`, `allow: []`, `deny: []` |
| Does not declare `repository.exec` | `default: deny`, `allow: []`, `deny: []` |

Gardener does not sandbox the runner, so `repository.exec` can reach any host and could send private
source anywhere. Host lists are rejected, because this target cannot enforce them. `generate` warns
about every task that declares `repository.exec`.

## Limits

| Key | Required | Meaning | Allowed |
| --- | --- | --- | --- |
| `runtime-seconds` | yes | Wall-clock limit for the run. | 30–21,000 |
| `max-turns` | yes | Model responses. | at least 3 |
| `max-tool-calls` | yes | Tool calls, including the final `finish_task`. | at least 3 |
| `input-tokens` | yes | Largest single model request. The conversation is resent each turn. | any positive |
| `output-tokens` | yes | Total generated across the run, including reasoning. | at least 16 × `max-turns` |
| `max-effect-operations` | no | Most operations one plan may propose. Needs at least one effect. | 1–1,000 |
| `max-effect-bytes` | no | Largest plan. | 1,024–50,000,000 |

A run that exceeds a limit fails with `budget-exceeded` and changes nothing. Every plan and receipt
must also fit in 4 MiB of canonical JSON, and one commit may change at most 1,000 files. The plan
job times out after `runtime-seconds` plus 10 minutes.

There is no limit across runs: a task anyone can trigger runs once per event. To cap total model
use, set a rate limit on the installation's AI Gateway; see
[Capping model use](operations.md#capping-model-use).

## Model

| Prefix | Request format |
| --- | --- |
| `@cf/…` | Workers AI, OpenAI-compatible chat completions |
| `openai/…` | OpenAI Responses |
| `anthropic/…` | Anthropic Messages |
| anything else | OpenAI-compatible chat completions |

Quote `@cf/` IDs in YAML. `generate` warns about other prefixes, which may not support tool calls.
Non-Cloudflare models need provider keys or Unified Billing on the installation's AI Gateway.

## Manual runs

| Input | Offered when | Meaning |
| --- | --- | --- |
| `prompt` | always | Extra instructions for this run, up to 20,000 characters. |
| `issue` | the task has an issue trigger | Issue number to run against. |
| `pull_request` | the task has a pull request trigger | Pull request number to run against. |

Give at most one target. Start a run from the workflow's **Run workflow** button or with
`gh workflow run gardener-<id>.yml`.

## Reactions

| Outcome | Reaction |
| --- | --- |
| Running | 👀 |
| Plan applied | 🚀 |
| Planning or applying failed | 😕 |
| Nothing proposed, skipped or cancelled | none |

Reactions go on the issue, pull request, comment or discussion that started the run, and only for
authors the task admits; `maintainers` is approximated by GitHub's `author_association`, so a
private organization member may get none. Review submissions, schedules, pushes and manual runs
get none. Projects pinned to 0.1.12 or earlier get none.

## Generated workflows

Each task's workflow calls Gardener's reusable workflow at the release's commit. Its jobs:

| Job | Checkout | Runs | Token |
| --- | --- | --- | --- |
| Plan | yes | the model and its tools | read-only, declared on the job |
| React, React with result | no | fixed reaction API calls | the caller's grant |
| Apply | no | the exact plan the runtime validated | the caller's grant |

The caller grants the union the jobs need: the planning job's fixed read scopes (`checks`,
`contents`, `discussions`, `issues`, `pull-requests`, `statuses`, plus `id-token: write`), the write
scopes of the declared effects, and the reaction scopes (`issues`, `pull-requests` or `discussions`
write, depending on the triggers). That union is the task's maximum authority.
