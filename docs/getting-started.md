# Getting started

This guide deploys Gardener to your Cloudflare account, connects one GitHub repository, and runs a
task that triages new issues. It takes about ten minutes.

Gardener has two halves. The **runtime** is a Cloudflare Worker and D1 database in your account; it
runs the model and checks every plan. The **tasks** live in your repository as `TASK.md` files, and
GitHub Actions runs them. One runtime can serve many repositories.

## Before you start

You need:

- Node.js 24 or later.
- A Cloudflare account. Workers AI usage is billed to it.
- Wrangler logged in to that account: `npx wrangler login`. If your login can see several accounts,
  set `CLOUDFLARE_ACCOUNT_ID` to the one to use.
- The GitHub CLI logged in with admin access to the repository: `gh auth login`.
- For a repository in an organization, an Actions policy that allows the reusable workflows in
  `scuffi/gardener` (**Organization settings → Actions → General**).

## 1. Deploy the runtime

Pick a workspace name. It names the Worker and database (`gardener-<workspace>`), and you pass it to
every later command.

```bash
npx @scuffi/gardener deploy --workspace my-gardener
```

`deploy` prints the runtime's URL when it finishes. Running it again updates the runtime in place.

If it stops with "Cloudflare Access protects the runtime hostname", your account's Access policy
covers every `workers.dev` hostname, so GitHub's runners can't reach the Worker. Create an API token
with **Access: Apps and Policies → Edit**, then rerun:

```bash
export CLOUDFLARE_API_TOKEN=...
npx @scuffi/gardener deploy --workspace my-gardener
```

`deploy` uses it to exempt the runtime's hostname from Access, and doesn't store it. Every request to
the runtime still needs a GitHub OIDC token from your repository.

Check the installation:

```bash
npx @scuffi/gardener doctor --workspace my-gardener
```

## 2. Add Gardener to your repository

From a checkout of the repository's default branch:

```bash
npx @scuffi/gardener init
```

This creates `.gardener/gardener.json`, which pins the Gardener release your workflows use, and
`.gardener/SKILL.md`, a guide to writing tasks that coding agents pick up.

Add a task. This one comments on each new issue with a summary and likely duplicates, and adds up to
two of the repository's existing labels:

```bash
mkdir -p .gardener/tasks/triage
curl -sL -o .gardener/tasks/triage/TASK.md \
  https://raw.githubusercontent.com/scuffi/gardener/main/examples/tasks/triage/TASK.md
```

Open it to see what a task looks like: YAML frontmatter that states its trigger, tools, effects and
limits, then the model's instructions. [`examples/tasks`](../examples/tasks) has two more starters,
`pr-review` and `mention-reply`.

Compile it:

```bash
npx @scuffi/gardener generate
```

`generate` validates every task and writes `.gardener/gardener.lock.json` and one workflow per task
in `.github/workflows/`, plus `gardener-sync.yml`, which keeps the runtime in step with the default
branch. Run it again whenever you change a task.

## 3. Connect the repository

```bash
npx @scuffi/gardener connect --workspace my-gardener --repository my-org/my-repo
```

This enrolls the repository with the runtime, uploads its compiled tasks, and sets the repository
variable `GARDENER_RUNTIME_URL`. It's the only step that needs your Cloudflare login; from now on,
pushing to the default branch keeps the tasks up to date.

Then commit and push:

```bash
git add .gardener .github/workflows
git commit -m "Add Gardener"
git push
```

The push starts **Gardener · Sync tasks**, which enrolls the tasks on the default branch.

## 4. Try it

Open an issue in the repository. Within a minute or two:

- the issue gets a 👀 reaction while the task runs;
- the **Gardener · triage** workflow appears in the **Actions** tab, with a plan job and an apply
  job;
- the task comments on the issue and labels it, and 👀 becomes 🚀.

Each run's job summary shows what the task saw, what it proposed and what was applied. You can also
list runs from the command line:

```bash
npx @scuffi/gardener runs --workspace my-gardener --repository my-org/my-repo
```

The triage task runs for every new issue, whoever opens it, so on a public repository anyone can
start a model run. To limit that, set `authors` on its trigger (see
[Mentions and authors](task-authoring.md#mentions-and-authors)), or cap model use with an
[AI Gateway rate limit](operations.md#capping-model-use).

## Next steps

- [Creating tasks](task-authoring.md): write your own, and choose its triggers, effects and limits.
- [Task reference](task-reference.md): everything a task can declare.
- [Onboarding](onboarding.md): more starter tasks, and upgrading to a new release.
- [Operations](operations.md): AI Gateway, capping model use, the kill switch, and upgrades.
- [CLI reference](cli.md): every command.

To stop every task in a repository straight away:

```bash
npx @scuffi/gardener repository disable --workspace my-gardener --repository my-org/my-repo
```
