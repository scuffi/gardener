# Operations

Run the CLI from npm as `npx @scuffi/gardener <command>`, pinned to one release with
`@scuffi/gardener@<version>` when you operate several repositories. Most commands take these flags:

| Flag | Meaning |
| --- | --- |
| `--workspace <name>` | Names the installation. Its Worker and D1 database are both `gardener-<workspace>`. |
| `--repository-root <path>` | Points at the customer repository. It defaults to the current directory. |
| `--source-root <path>` | Deploys the Worker from a Gardener source checkout instead of the runtime bundled in the package. Only for developing Gardener. |

`gardener <command> --help` lists every option.

## Prerequisites

- Node.js 24+.
- `npx wrangler login` and `gh auth login` completed for the target accounts.
- The customer repository's Actions policy must allow `scuffi/gardener`'s actions and reusable
  workflow. The default policy allows all actions. If the repository or its organization allows
  only selected actions, add the ones under `scuffi/gardener` to the allowed list.
- If any task opens pull requests or approves reviews, turn on **Allow GitHub Actions to create and
  approve pull requests** in the customer repository's **Settings → Actions → General → Workflow
  permissions**. It is off by default for new repositories. Without it, apply stops at the
  pull-request step with `GitHub Actions is not permitted to create or approve pull requests`,
  and rerunning the failed job after enabling it resumes from that step. `doctor`, which `yolo` and
  `upgrade` also run, warns when the setting is off. Leave the default workflow
  permissions at read-only: each generated workflow requests exactly the permissions its task needs.
- If any task sets a non-Cloudflare `model:` (for example `openai/…` or `anthropic/…`), the gateway
  its requests go through needs that provider's key or Unified Billing. By default that is the
  Cloudflare account's AI Gateway named `default` (**AI → AI Gateway**); to use another gateway,
  including one in a different account, see [AI Gateway](#ai-gateway). Gardener stores no provider
  keys. Without them, runs of that task fail at the first model call. `@cf/…` models need nothing
  extra.

## Install

```bash
npx @scuffi/gardener yolo \
  --workspace my-gardener \
  --repository my-org/my-repo \
  --repository-root /path/to/my-repo \
  --demos
```

`yolo` runs `init`, `generate`, `deploy`, `connect`, and `doctor` in order. Each step can also be run on
its own:

| Command | Effect | Remote changes |
| --- | --- | --- |
| `init [--demos]` | Creates `.gardener/`, optionally with the two demo tasks | None |
| `generate` | Compiles tasks, writes the lock file and one workflow per task | None |
| `deploy` | Creates or adopts the D1 database, applies migrations, deploys the Worker, records installation facts, checks `/health` | Cloudflare |
| `connect` | Enrolls the repository and its bundle hashes, sets `GARDENER_RUNTIME_URL`, and starts the sync workflow on the default branch if it is there yet. Needed once per repository | D1, GitHub variable, one workflow run |
| `doctor` | Verifies the installation. Warns about enrollments whose workflow pin differs from this CLI, and repositories whose tasks open or approve pull requests without the setting below | None |

`init` and `generate` never overwrite existing task files or workflows that Gardener did not generate.
Rebuilding unchanged tasks produces byte-identical output. No command commits or pushes, so review
the generated files and commit them yourself.

The CLI keeps no local state. Every command finds the installation on the Cloudflare account that
`wrangler` is logged in to (set `CLOUDFLARE_ACCOUNT_ID` if it can see several) by the
`gardener-<workspace>` name. `deploy` records the runtime URL, CLI version and deployment digest in
the workspace's own D1, so any operator with access to the account can run any command. `deploy`
adopts existing `gardener-<workspace>` resources, and refuses to replace a runtime that a newer CLI
deployed. If a command is interrupted, rerun it unchanged.

### Cloudflare Access

Some accounts have an Access policy covering every `workers.dev` hostname. In that case, GitHub
runners cannot reach the Worker. `deploy` detects this and stops. Provide a token scoped to
**Access: Apps and Policies — Edit** and rerun:

```bash
export CLOUDFLARE_API_TOKEN=...
npx @scuffi/gardener deploy --workspace my-gardener
```

Gardener creates an Access bypass for the runtime hostname only. The bypass grants network
reachability, nothing more: every session still requires a valid GitHub OIDC token. The token is
used in memory and never stored.

Alternatively, exclude the runtime hostname from the Access policy yourself, for example with a
bypass application for that hostname only, and rerun `deploy`. It continues once `/health` is
reachable without Access.

### AI Gateway

Every model call goes through AI Gateway. Without further setup, that is the `default` gateway of
the account the runtime is deployed to, reached through the Workers AI binding. To send
non-Workers-AI models (`anthropic/…`, `openai/…` and other providers) to a gateway of your choice,
including one in another account, pass it to `deploy` with a token that may use it:

```bash
export GARDENER_AI_GATEWAY_TOKEN=...
npx @scuffi/gardener deploy --workspace my-gardener \
  --ai-gateway <account-id>/<gateway-id> --ai-gateway-project my-project
```

- The token is sent as `cf-aig-authorization` and stored only as the runtime Worker's
  `GARDENER_AI_GATEWAY_TOKEN` secret. It never reaches a runner.
- `--ai-gateway-project` is optional and sent on every request as
  `cf-aig-metadata: {"project": "…"}`, for gateways that attribute usage by project.
- `@cf/…` models keep running on the runtime's own account.
- Later `deploy` and `upgrade` runs keep the gateway. Set `GARDENER_AI_GATEWAY_TOKEN` again to
  rotate the token, or pass `--ai-gateway off` to go back to the account's own gateway. An exported
  token is ignored when deploying an installation without a gateway.

### Capping model use

A task runs once for every event that matches it. Two kinds of limit stop that from running away.

Each task's [run limits](task-authoring.md#run-limits) bound how often that task calls the model:
`runs-per-author` (3 a day for each outsider unless the task says otherwise) and `runs` (the task's
total, maintainers included, with no default). A run over either finishes as a skip before the
model is called, so it costs nothing. They don't bound many tasks together, and a task without
`runs` isn't bounded against one person with many accounts.

The AI Gateway cap is account-wide: it covers every task in every repository on the installation,
and anything else that uses the gateway. Set it as the outer ceiling, with AI Gateway
[rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/), and keep
tasks with public triggers on `authors: maintainers` where you can.
Set it on the account's `default` gateway, which `@cf/…` models always use, and on the gateway
passed to `--ai-gateway` if there is one. A request over the limit fails with HTTP 429. Gardener
retries a request to the `--ai-gateway` gateway twice with backoff, then fails the run without
changing anything. Gardener does not retry `@cf/…` models' requests through the `default` gateway.

## Changing tasks

Edit `.gardener/tasks/<task>/TASK.md`, then run `gardener generate` and commit the updated lock
file and workflows. Nothing else is needed. When the change reaches the default branch, the
generated `gardener-sync.yml` workflow compiles the tasks with the pinned release's compiler and
enrolls exactly those:

- new and edited tasks go live, and deleted tasks stop;
- `draft: true` tasks run only by hand;
- reverting a task brings its earlier version back.

Pull request events run the workflows in the pull request's merge commit, which GitHub does not
always rebuild when the base branch moves. A pull request opened before a task was added may
therefore not run that task, for example a review task, until its branch is updated or it gets a
new commit.

The sync is refused unless it is Gardener's pinned sync workflow, at the repository's enrolled
release or the release the Worker was deployed from, running on the default branch of a connected
repository. A sync from the Worker's release moves the repository to that release. `deploy`
refuses to replace a runtime from a newer CLI, so this never moves a repository backwards.

If the committed lock or workflows don't match the tasks (someone edited a `TASK.md` without
rerunning `generate`), the sync run fails, and the previously enrolled tasks keep running. Rerun
`generate` and commit. Pull requests that touch Gardener's files get a **Check tasks** check that
reports the same problem before merge. It runs read-only, with no token and no call to the
runtime, so it is safe on pull requests from forks. Before compiling anything it refuses more
than 100 tasks, the most one sync carries, and any `TASK.md` over 512 KiB. It only runs on pull
requests that touch those files, so don't make it a required status check: other pull requests
would wait for it forever. A pull request can edit its own checks anyway, so the sync after merge remains the
enforcement. To resync by hand, run the **Gardener · Sync tasks** workflow from the
Actions tab, or run `connect` from an up-to-date checkout of the default branch. `connect` also
starts a sync from the default branch, which replaces the bundles it enrolled from your checkout.
If that run goes red, the default branch's generated files are older than your checkout's: merge
the regenerated files.

Anyone who can push to the default branch decides what Gardener may do there. Protect it with
required reviews or a CODEOWNERS entry for `.gardener/**` if that matters for the repository.

## Chat messages

Tasks that declare `message.send` post to the chat space in the `GARDENER_CHAT_WEBHOOK` repository
secret. Create an incoming webhook in Google Chat (space → Apps & integrations → Webhooks) or in
Slack (an app with incoming webhooks), and store its URL:

```sh
gh secret set GARDENER_CHAT_WEBHOOK --repo owner/repo
```

The generated caller passes the secret to Gardener's workflow only for tasks that declare
`message.send`, and only the apply step receives it. It is masked in logs, read once and removed
from the step's environment, and never written to the plan, the receipt or the job summary. Only
`https://chat.googleapis.com/` and `https://hooks.slack.com/` URLs are used; any other value is
skipped, and the job summary says so without showing it. Without the secret, runs skip the message.
Anyone who can edit repository secrets can point messages at another space.

Each message shows an emoji picked from the subject's labels (`regression`, `bug`, `enhancement`,
`question`, `documentation`, else 🆕), the repository name, a link to the subject, its author and
title, and on a second line the model's summary. See
[Messages](task-authoring.md#messages) for the exact format and how titles are made inert.

A plan's Google Chat message reaches the space at most once: each post carries a `messageId` derived from the
plan's digest (not secret), and Chat refuses a repeat with `409 ALREADY_EXISTS`, which apply counts
as sent. Slack has no such key, so a rerun after a lost answer can post twice. Google Chat accepts about
one message per second per space; a burst of runs whose messages fail with `429` can be rerun.
Chat remembers the id only while the message exists: if someone deletes it and the apply job is
rerun, it can be posted again. To rotate the destination, replace the secret; to stop messages without changing tasks, delete it.

## Bot dispatches

From 0.1.21, a manual run (`workflow_dispatch`) whose actor is a bot, such as a GitHub App
installation token or `github-actions[bot]`, is admitted only as a run another task started with
`task.run`. One that matches no such request fails before the model with `lineage.unmatched`
("Refused before the model: … dispatched by a bot …"), writes an `actions_task_audit` row, and
changes nothing. This includes your own Apps and automation that dispatch Gardener workflows: run
those through a person's token (a personal access token reads as that person and is trusted as a
manual run), or have a Gardener task start the task with `task.run`. A bot dispatch that carries a
`prompt` is refused even when it matches. A person's **Run workflow** is unaffected.

A task that declares `task.run` has its caller job granted `actions: write`; `generate` warns about
it. With that grant the job can also delete workflow runs, logs and artifacts, so for those
repositories the Worker's `actions_task_audit` table, not the Actions logs, is the durable record. See
[SECURITY.md](https://github.com/scuffi/gardener/blob/main/SECURITY.md#starting-other-tasks).

If apply reports a task run as `dispatch_unknown`, the job fails and Gardener will not dispatch it
again. Check the target task's workflow runs; if it did not start, start it by hand with
`gh workflow run gardener-<task>.yml -f issue=<n>` (or `-f pull_request=<n>`).

## Inspecting runs

```bash
npx @scuffi/gardener repositories --workspace my-gardener
npx @scuffi/gardener tasks        --workspace my-gardener
npx @scuffi/gardener runs         --workspace my-gardener
npx @scuffi/gardener runs view --run <run-id> --workspace my-gardener
```

`runs view` prints the run, its effect receipt, and its audit records.

## Kill switch

```bash
npx @scuffi/gardener repository disable --workspace my-gardener --repository my-org/my-repo
```

`repository disable` blocks planning, apply and syncs for every task in the repository. It takes
effect immediately and is recorded in `actions_control_audit`. Use `repository enable` to reverse
it. To stop a single task, delete it or set `draft: true` on the default branch.

## Qualification

After pushing the generated demo workflows:

```bash
npx @scuffi/gardener debug --workspace my-gardener --repository my-org/my-repo \
  --repository-root /path/to/my-repo
```

`debug` opens one issue per demo task and waits for both workflows. It then checks for exactly
one Gardener comment and one matching receipt in D1. Add `--drills` to also check that a disabled
repository is refused and that cancellation settles correctly.

## Upgrade

Existing repositories keep their workflow pin until you move them:

```bash
npx @scuffi/gardener upgrade --workspace my-gardener \
  --repository-root /path/to/my-repo
```

`upgrade` performs these steps:

1. redeploys the Worker with the runtime bundled in this release;
2. moves the repository to this CLI's workflow pin;
3. rebuilds the workflows;
4. moves `package.json` scripts that run a pinned `@scuffi/gardener` (such as a
   `gardener:generate` script) to this release;
5. runs `doctor`.

Run it once per repository, then commit and push the regenerated files. The repository keeps
running on its previous release until they reach the default branch, where the sync moves it to
the new one. Runs from the new workflows are accepted in between, because the Worker also trusts
its own release, so nothing is refused while the sync catches up.

Some releases change the bundle format, which changes every bundle hash. After such a release's
Worker is deployed, runs for a repository fail with `Stored task bundle predates this Gardener
runtime` until that repository has been upgraded and its regenerated workflows pushed.

To go back to an earlier release, deploy or upgrade from that release's CLI. `deploy` refuses to
replace a newer runtime, so this needs a newer release that reverts the change. Migrations are
forward-only.

Going back below 0.1.17 fails any run that 0.1.17 admitted and that is still in flight: its stored
request records who started it, which an older runtime refuses to read. Let in-flight runs finish,
or rerun them afterwards. Migration 0005, which holds run admissions for the run limits, only adds a
table, so it is safe to leave in place; older runtimes ignore it.

Going back below 0.1.18 fails any run still in flight whose plan carries a message (a task that
declares `message.send` and proposed one): an older runtime cannot read the stored plan, or the
receipt that records the message. This is accepted; rerun such runs afterwards. Plans without a
message are unaffected.

Gardener has no teardown command. To remove an installation, delete its `gardener-<workspace>`
Worker and D1 database, and any Access application for its hostname, in the Cloudflare dashboard.

## Using a coding agent

A coding agent should drive the same CLI rather than call Wrangler, the Cloudflare API, or the
GitHub API directly. A prompt that works:

```text
Set up Gardener in this repository using only the Gardener CLI.

1. Check `gh auth status` and `wrangler whoami` without printing credentials.
2. Ask me for a short lowercase workspace name.
3. Run `npx @scuffi/gardener yolo --workspace <name> --repository <owner/name> --demos`, passing
   --repository-root explicitly.
4. If it stops, rerun the identical command. Do not recreate any step by hand.
5. Show me the generated files, runtime URL, bundle hashes, and doctor result.
6. Do not commit or push.
```
