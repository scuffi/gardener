# Gardener

Gardener runs AI maintenance tasks on your GitHub repositories from GitHub Actions. You describe a
task in a Markdown file: when it runs, what it may read, and exactly which changes it may make. A
model does the work inside the task's limits, and a separate job applies only the changes the task
allows.

Everything runs in your own accounts: a Cloudflare Worker with Workers AI and D1, plus Actions
workflows in your repository. There is no GitHub App, webhook, personal access token, or stored
GitHub secret.

## How it works

Each task compiles to a GitHub workflow with two jobs:

1. **Plan.** The workflow checks out the repository with a read-only token. It then opens a
   session to your Gardener Worker, authenticated with GitHub OIDC. The model inspects the
   repository through the task's declared tools and proposes effects. The Worker validates each
   proposal and returns an exact, hash-bound effect plan.
2. **Apply.** A second job, with no checkout, downloads the plan and verifies its hash with the
   Worker. It then performs each operation in order using the job's `GITHUB_TOKEN`. It
   re-checks GitHub state before every write, stops at the first failure, and records a receipt
   for each step.

The model never holds a write-capable token, and the job holding the write token never runs
repository code.

## Quick start

Requirements:

- Node.js 24+, pnpm 11.25, and authenticated `wrangler` and `gh` sessions;
- a repository whose Actions can use this repository's reusable workflow (see
  [Prerequisites](docs/operations.md#prerequisites));
- for tasks that open pull requests, **Allow GitHub Actions to create and approve pull requests**
  turned on in that repository's **Settings → Actions → General**. New repositories have it off.

```bash
git clone https://github.com/scuffi/gardener && cd gardener
pnpm install

pnpm gardener -- up \
  --workspace my-gardener \
  --repository my-org/my-repo \
  --repository-root /path/to/my-repo \
  --source-root "$PWD" \
  --demos
```

`up` does five things:

1. scaffolds `.gardener/` with two demo tasks;
2. compiles them and generates their workflows;
3. deploys the Worker and D1 database to your Cloudflare account;
4. enrolls the repository;
5. verifies the installation.

It is safe to rerun after an interruption. It never commits, so review and push the generated files
yourself:

```bash
cd /path/to/my-repo
git add .gardener .github/workflows
git commit -m "Add Gardener"
git push
```

Open an issue labeled `gardener-bug` to run the bug-intake demo.

## Writing a task

```markdown
---
schema: gardener.task/v1
id: bug-intake
name: Bug intake
description: Helps issue authors provide actionable bug reports.
trigger:
  event: github.issue.opened
  labels-all: [gardener-bug]
tools:
  - repository.list_files
  - repository.read_file
effects:
  - issue.comment.create
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 300
  max-turns: 16
  max-tool-calls: 12
  input-tokens: 60000
  output-tokens: 16000
---
Read the issue and the relevant code. If the report is missing reproduction steps, expected
behaviour, or version information, post one comment asking for exactly what is missing.
```

Save it as `.gardener/tasks/bug-intake/TASK.md` and run `pnpm gardener -- build`, then
`pnpm gardener -- connect`.

Tasks can respond to 26 kinds of issue, pull request, discussion, push, schedule, and manual
events. They can use 29 kinds of GitHub operation, including:

- labels and comments;
- reviews;
- branches and commits;
- draft pull requests and merges;
- check reruns;
- releases.

The GitHub token permissions in each generated workflow are derived from the task's declared
effects. See [Task authoring](docs/task-authoring.md) for the full format.

## Security model

- **Authentication.** The Worker accepts a session only with a fresh GitHub OIDC token. The token
  must match all of the following:
  - the enrolled repository and owner IDs;
  - the run and attempt;
  - the event, ref, and commit;
  - a GitHub-hosted runner;
  - the exact reusable-workflow commit.
- **Task integrity.** Task definitions are stored in D1 by SHA-256. Each run loads the enrolled
  hash and recomputes it.
- **Model limits.** The model can only propose operations the task declares. It cannot add
  commit contents or idempotency markers. Gardener derives both itself.
- **Fork pull requests** never run, and `pull_request_target` is not supported.
- **Apply safety.** Operations carry the GitHub state they expect. Apply stops rather than
  overwrite a change made after planning.

See [Security](SECURITY.md) and [Architecture](docs/architecture.md) for details.

## Status and limitations

Gardener is pre-release.

- **Live testing is narrow.** Only the issue-comment path has been tested end to end against real
  GitHub. The other triggers and operations pass the test suite but are not yet proven live.
- **Effects apply automatically.** There is no human approval step, so a task that declares
  `pull_request.merge` or `release.delete` can do those things unattended. Declare the narrowest
  effects you can.
- **`repository.exec` has unrestricted network access.** It runs task-chosen commands with the
  runner's normal egress. Do not use it on sensitive private code.
- **Install from source only.** Gardener is not published to npm. Repositories can use the
  reusable workflow only if they can access this repository.
- **Cloudflare Access.** If Access protects every `workers.dev` hostname on your account,
  `deploy` needs a `CLOUDFLARE_API_TOKEN` scoped to Access Apps and Policies. It uses this to add a
  bypass for the runtime hostname only.

## Documentation

- [Task authoring](docs/task-authoring.md): task format, triggers, tools, effects, and limits
- [Operations](docs/operations.md): deploying, upgrading, kill switches, and teardown
- [Architecture](docs/architecture.md): components, data, and the plan/apply protocol
- [Security](SECURITY.md): trust boundaries and how to report a vulnerability

## Development

```bash
pnpm install
pnpm check   # versions, typecheck, tests, builds, package and bridge checks, deploy dry run
```

| Path | Contents |
| --- | --- |
| `apps/gardener` | Cloudflare Worker runtime |
| `packages/cli` | `gardener` CLI and task compiler |
| `packages/runner` | GitHub bridge source; built into `bridges/github` |
| `packages/contracts` | Task, event, and operation schemas |
| `packages/protocol` | Cap'n Web session protocol |

## License

Apache-2.0
