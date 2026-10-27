# Security

## Reporting a vulnerability

Report vulnerabilities privately to the maintainers through GitHub's private vulnerability
reporting on this repository. Do not put credentials, private repository content, model prompts, or
workflow logs from a private repository in a public issue.

## Deployment model

Each installation is self-hosted. It consists of one Cloudflare Worker with a D1 database and
Workers AI in the operator's Cloudflare account, plus generated workflows in each enrolled
repository. The installation is the tenant boundary. Gardener runs no shared service and receives
no data from installations.

The Worker holds no GitHub credential. Repository access comes only from the `GITHUB_TOKEN` that
GitHub issues to each workflow job, with permissions fixed by the generated workflow.

## Trust boundaries

| Component | Trusted with | Never receives |
| --- | --- | --- |
| Worker | Task bundles, run state, plan validation, receipts | Any GitHub token |
| Plan job | Read-only `GITHUB_TOKEN`, OIDC token, checkout | Write permissions |
| Model and `repository.exec` | Repository contents, via declared tools only | Any GitHub token, the OIDC token |
| Apply job | Write scopes implied by the task's declared effects | A checkout, repository code, model output other than the validated plan |

Untrusted inputs are:

- model output;
- repository contents;
- issue, pull request, and comment bodies;
- anything a `repository.exec` process writes.

Each one can influence what is proposed. None of them can widen what is allowed.

## Session authentication

The Worker exposes three routes: `GET /health`, `/session/<id>` and `POST /v1/sync`. Every other
path returns 404. `/v1/sync` accepts a repository's compiled tasks only with a GitHub OIDC token
from the pinned sync workflow, run on the repository's default branch.
Opening a session grants nothing until the runner presents a GitHub OIDC token. The Worker verifies
the token signature against GitHub's issuer and requires all of the following:

- the enrolled numeric repository and owner IDs;
- the run ID and attempt, the event name, the ref, and the commit SHA;
- a GitHub-hosted runner, `runner_environment: github-hosted`;
- the exact reusable workflow reference, `job_workflow_ref`, pinned to a full commit SHA;
- the Worker's own origin as audience;
- the job phase, plan or effects.

Tokens bound to a GitHub environment are rejected. A disabled repository cannot authenticate either
phase.

## Planning

- The plan job checks out with `persist-credentials: false`. Its token is read-only.
- Task definitions are canonical `TaskBundleV1` JSON stored by SHA-256. The Worker loads only
  hashes enrolled for the authenticated repository, recomputes the hash, and checks the event
  against the task's declared triggers. It never parses Markdown or YAML.
- The model reaches the repository only through the task's declared tools.
  - `provider.api.read` allows REST `GET`/`HEAD` and GraphQL queries. The bridge process holds the
    token, so it never reaches model context or a child process.
  - `repository.exec` runs with the token and OIDC request variables removed from its environment.
- The model proposes effects one at a time. It supplies a step name, an operation kind, a payload,
  and references to earlier steps' outputs. The Worker validates each proposal against three
  constraints:
  - the task's declared effects;
  - the strict operation schema;
  - typed references, which may point only to scalar outputs of earlier steps.
- The Worker derives the parts the model must not control:
  - operation IDs;
  - repository identity;
  - idempotency markers;
  - commit file contents.
- Fork pull requests are rejected twice: in the generated workflow, and by a runtime head-repository
  check. `pull_request_target` cannot be generated.

### Effect scope

Before the model runs, the Worker decides whether the run's starter is trusted, from the signed
OIDC event name and actor and the event Gardener's bridge reported, and freezes the answer in the
run's request. Trusted starters are schedules, manual runs, pushes and same-repository
`synchronize` by a person, a subject's author who counts as a maintainer, and anyone else with
write or admin access as the bridge looked it up with the read-only token. Bots, outsiders, fork
heads and failed lookups are untrusted; every doubt narrows. See
[Effect scope](docs/task-authoring.md#effect-scope).

An untrusted starter's run is confined to its trigger. What that guarantees:

- every step that targets an issue, pull request or discussion targets the one that triggered the
  run, matched by kind and number, or one an earlier step of the same plan created, except that a
  merge or review must name the triggering pull request itself, so a run can't merge or approve a
  pull request it opened;
- no step edits, publishes or deletes an existing release, or re-runs a check;
- the same pure check runs when each step is proposed, when the Worker builds the plan, and when
  apply re-parses the digest-bound plan, so the three cannot disagree. Plans for runs pinned to
  0.1.16 or earlier don't carry the scope, because their apply would refuse the field; those keep
  the first two checks.

Each task's run limits are enforced in one atomic D1 statement before the model starts: by default
an untrusted starter may cause three runs of a task a day.

### Captured changes

A task that commits code does not put file bytes in its plan. When a commit is proposed, the
bridge captures the working tree changes into a separate artifact. The manifest records each path's status, mode,
size, and SHA-256, and the plan binds the manifest digest.

A capture may not write these paths:

- anything under `.git/`, `.github/workflows/`, `.github/actions/`, or `.gardener/`;
- `CODEOWNERS`, `.github/CODEOWNERS`, and `docs/CODEOWNERS`;
- `.github/dependabot.yml` and `.github/dependabot.yaml`.

Apply verifies the artifact against the plan, then re-verifies each file's size and digest as it
uploads the file.

## Apply

The apply job has no checkout and runs no repository code. It performs these steps:

1. Download the plan artifact and verify its SHA-256.
2. Authenticate as the effects phase.
3. Have the Worker confirm the plan is the one it issued for this run.
4. Execute each operation in order.
5. Send the plan's message, if it has one, once every operation applied.
6. Start the plan's task run, if it has one, after that, whatever became of the message.

Every operation carries the GitHub state it was planned against. Depending on the operation, that
can include:

- the issue or pull request state and `updated_at`;
- the head SHA;
- the comment timestamps;
- the release state.

Apply re-reads that state before writing. A mismatch is a terminal conflict, never a retry.

A plan can write the same issue, pull request, or discussion more than once, for example a comment
followed by a label. After a write that passed its `updated_at` check, apply reads back the new
`updated_at` and records it in the step receipt. A later step on that resource accepts either its
planned value or that recorded value. Changes by anyone else still conflict, except for one landing
in the moment between Gardener's write and its read-back. A step that found its effect already in
place never extends the chain. Two writes to the same release or comment in one plan still conflict.

Apply stops at the first failure. Re-running the apply job resumes after the last operation that
succeeded exactly. Operations can be matched after an interrupted run through markers that trusted
code adds:

- an HTML comment, `<!-- gardener-operation:<id> -->`, on comments, reviews, and pull request
  bodies;
- a `Gardener-Operation:` trailer on commits.

Gardener branches, commits and pull request heads are limited to `gardener/**` branches unless a
task lists other `branches` on that effect. A wildcard never matches the default branch: a task can
write to it directly only if it names it exactly. Every commit sits directly on the commit the task
checked out. Branch lists do not limit two pull request kinds. `pull_request.merge` can merge a pull
request into any base, including the default branch, so its required checks are the gate.
`pull_request.update_branch` can update any pull request's head with its base; with
`method: rebase` GitHub rebases and force-updates that branch, which changes its commits and can
dismiss reviews. GitHub computes that history and applies it only if the head is still the one the
task saw. No other operation can force-push, and none can delete a branch.

### Messages

A plan carries at most one message: a subject (an issue, pull request or discussion, by number and
the `updated_at` the model read) and a summary. The destination is not in the plan, the receipt or
anything the model sees. It is the `GARDENER_CHAT_WEBHOOK` secret, which the generated caller
passes only for tasks that declare `message.send`, and which Gardener's reusable workflow
interpolates only into the apply step. The planning job, which runs the model, never receives it.
The apply step masks it, deletes it from its environment, and posts only to
`https://chat.googleapis.com/` or `https://hooks.slack.com/`, by exact host, with redirects refused.
The only thing apply adds to the URL is Google Chat's `messageId`, a hash of the plan artifact's
digest, which the receipt records anyway, so it reveals nothing. Errors from the chat service are
cut short and scrubbed of the URL and its parts before they reach the log or job summary. A task may not declare both `message.send` and `repository.exec`, so no
task-controlled command runs in a job that could see the secret.

The summary is limited when the model proposes it: one line, at most 400 characters, no `<`, `>`,
`&`, backticks, control or format characters, and no Gardener marker. Apply then fetches the
subject's title, author and link itself, and refuses to send if the subject changed since planning,
except by the plan's own steps, or if its link leaves the repository. The title and summary are
sanitized with the same rules, and so is the repository name: NFKC normalization first (so
fullwidth `＜` or `．` count as `<` and `.`), control and format characters dropped, one line,
lookalikes for every formatting character either product knows (`<`, `>`, `*`, `_`, `~`,
backticks), and link-like text defanged (`://` becomes `:∕∕`, and the dots of anything shaped like
a host name, in any script and including `。`, become U+2024), with Slack's `&` escaped first. A
leading list marker on the summary line is swapped for a lookalike. Bare IPv4 addresses and
`localhost` are not defanged; neither product links them without a scheme. No code span is relied on, so the only link in a
message is the one Gardener built to the subject. `#123` and `@login` stay as text; neither product
turns them into a link or a mention in incoming-webhook text.

### Starting other tasks

A plan carries at most one task run: a target task id, the workflow path the Worker derived from it
(`.github/workflows/gardener-<id>.yml`, never from the model), and a subject that is the run's own
issue or pull request, or a pull request an earlier step of the same plan opens. The model supplies
no inputs, prompt, ref or workflow. The Worker checks the target is declared, enrolled and enabled,
and offers the subject as a dispatch input, both when the step is proposed and when apply reports
`dispatching`; apply re-checks the path pattern and dispatches on the default branch it reads from
the API, with exactly one input. It never dispatches twice.

**Lineage.** A started run gains nothing from being started. Before apply calls GitHub, the Worker
records the dispatch (target task, subject, the parent's frozen starter decision, root author and
depth). A manual run whose actor is a bot is never trusted as a manual run: it must claim one of
those records (same repository, task and subject, unconsumed, at most six hours old) in one atomic
compare-and-swap, and inherits that record's decision, never a wider one, with the strictest record
handed out first when several match. It is charged to the chain's root author, may not carry a
`prompt`, and stops at depth 3. A re-run of the same workflow run finds the record it already
claimed. A bot dispatch that claims nothing fails before the model, with an `actions_task_audit`
row. Every matched run writes an audit row naming its parent run and depth. A person's manual run
is unchanged: it still needs write access to start.

**`actions: write`.** A task that declares `task.run` needs `actions: write` to dispatch. GitHub
does not evaluate expressions in `permissions:`, and apply deliberately inherits the caller job's
grant (its needs vary by task), so the grant cannot be scoped to the dispatch:

- only tasks that declare `task.run` get it, and it is granted on the caller job, so apply,
  `acknowledge` and `settle` all hold it for the duration of the run;
- beyond dispatching, it permits cancelling, re-running and **deleting workflow runs, logs and
  artifacts**, enabling and disabling workflows, and managing caches;
- it is contained: the plan job pins a narrower static block, so the model and any
  `repository.exec` command never hold it; apply is checkout-free and runs one pinned bridge against
  a hash-bound plan; `acknowledge` and `settle` run fixed API calls;
- the residual: the Actions run's own logs and artifacts are deletable by the same token that
  applies effects, so for a repository that uses `task.run` the durable audit record is the Worker's
  `actions_task_audit` table, not the Actions logs.

The option not taken: a second reusable workflow, called by a second generated caller job with a
static `permissions: { actions: write }`, taking the resolved task and subject from the first job's
outputs. It achieves least privilege at the cost of a second pin, a second `job_workflow_ref` for
the Worker to accept, outputs plumbing, and a dispatch outside the receipt flow.

## Known limitations

- **No human approval.** Declared effects apply automatically. A task that declares merge,
  release, or check-rerun authority can use it unattended.
- **Unrestricted egress from `repository.exec`.** It runs as the runner user with the runner's
  normal network access, so it can exfiltrate anything in the checkout. A hostile process can also
  tamper with the plan job's step outputs. It cannot change what is applied: the Worker
  independently re-derives the plan and its digest before apply, and any mismatch fails closed.
- **The default branch decides what runs.** On each push that touches Gardener's files, the
  generated sync workflow enrolls exactly the committed tasks. The runtime accepts a sync only from
  Gardener's pinned sync workflow, verified by the GitHub OIDC `job_workflow_ref` claim, running on
  the default branch (`ref`) of a connected, enabled repository. So pull requests, other branches
  and forks can't change enrolled tasks. But anyone who can push to the default branch can grant a
  task any effect. Protect the branch (required reviews, or CODEOWNERS for `.gardener/**`) where
  that matters. An unprotected branch is supported. The runtime trusts whichever branch GitHub
  reports as the default at sync time, so a repository admin who renames the default branch to
  an unprotected one can sync from it. Protecting the branch also means limiting who administers
  the repository.
- **Sync workflows come from Gardener's own repository.** The runtime accepts a sync only from
  the repository that ships the release it was deployed from (its `GARDENER_RELEASE_WORKFLOW_REF`),
  at the repository's enrolled commit or that release's commit. `connect` refuses a lock pinned to
  any other repository.
- **Trigger scope confines where, not what.** A run that outsiders can start still reads their
  text, and a task that declares `pull_request.merge` can merge the outsider's own pull request if
  that text persuades the model. `generate` warns about such tasks.
- **Maintainer-started runs read untrusted text.** A maintainer's comment on an outsider's issue
  gets repository scope, and the model still reads the outsider's issue. Keep instructions and
  effects narrow for tasks maintainers start on others' threads, or set `effect-scope: trigger`.
- **Bot pushes are untrusted.** A push or `synchronize` by a bot, including Dependabot, is confined,
  and with nothing behind it can only create: it may open issues, pull requests and branches.
- **`branch.create` under wide patterns.** A confined run may create any branch its task's
  `branches` patterns allow. The run limits bound how many.
- **Many accounts.** `runs-per-author` counts each GitHub account separately. Only a task's `runs`
  limit, or the AI Gateway cap, bounds someone with many accounts, and `runs` has no default.
- **Messages show outsiders' text.** A message quotes the subject's title, which its author wrote,
  and a summary the model wrote after reading untrusted text. Both are inert, but they can still
  say misleading things. In a private repository, everyone in the chat space sees the title.
- **Slack messages go out at least once.** Slack incoming webhooks take no idempotency key, so a
  rerun after a lost answer can post twice. Google Chat posts carry a `messageId` derived from the
  plan's digest, and Chat refuses a repeat, so a plan's message reaches a Chat space at most once.
- **Kill switch.** `gardener repository disable` blocks planning, apply and syncs for the
  repository. To stop one task, remove it from the default branch.

## Operator secrets

`.gardener/` and the generated workflows contain no secrets. The CLI keeps no local installation
state: it reads the installation from the Cloudflare account, and `deploy` records the runtime URL,
CLI version and deployment digest (none of them secret) in the workspace's D1.

A `CLOUDFLARE_API_TOKEN`, when provided for Cloudflare Access, is used in memory only. It is never
written to disk, D1, the Worker, GitHub, or command arguments.

A `GARDENER_AI_GATEWAY_TOKEN`, when provided for an [external AI Gateway](docs/operations.md#ai-gateway),
is piped to `wrangler deploy` and stored only as the runtime Worker's secret. It is never written to
disk, D1, GitHub, or command arguments, and never reaches a runner. Anyone who can edit the
runtime Worker can use it. The gateway sees every request, including repository content the model
reads.

A `GARDENER_CHAT_WEBHOOK` repository secret, when set, is a credential for posting to one chat
space. Anyone with it can post there; anyone who can edit repository secrets can redirect
messages. It is never written to the plan, receipt, D1 or job summary.

If you suspect compromise, disable the repository with `gardener repository disable`. Preserve the
D1 database. The database blocks updates and deletes on the run audit table, `actions_task_audit`, so
its rows serve as evidence.
