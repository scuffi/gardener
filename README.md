# Gardener

Gardener is an Actions-native repository steward that runs in a customer's Cloudflare account.
GitHub Actions owns triggers, checkout, repository permissions, and effect execution. Gardener owns
compiled task policy, Workers AI/Flue orchestration, durable Cap'n Web sessions, audit history, and
exact effect receipts.

> **Experimental bounded runtime:** the qualified path is intentionally narrow: an explicitly
> labeled `github.issue.opened` event may inspect repository files and propose exactly one
> SHA-256-bound `issue.comment.create` effect. Planning and effects are separate jobs. The planning
> job has no write token; the checkout-free effects job never executes repository code.

## Architecture

One headless installation consists of:

- one narrow public **Gardener runtime Worker** with Workers AI, Durable Objects, and D1;
- one **D1 database** containing repository enrollment, canonical task bundles, runs, audit events,
  and receipts;
- the **Gardener GitHub bridge** running inside GitHub-hosted plan/apply jobs;
- immutable, Gardener-owned reusable workflows consumed at a full commit SHA.

The runtime exposes only `/health` and `/session/<id>`; every other route returns `404`. A public WebSocket grants no authority. Each session must authenticate with
a short-lived GitHub OIDC token. Gardener verifies GitHub's signature and binds the token to the
enrolled numeric repository and owner IDs, run and attempt, event, ref, commit SHA, GitHub-hosted
runner, exact reusable-workflow SHA, audience, and effects environment.

Customer repositories need no App, webhook, PAT, or custom GitHub secret. Workflows use GitHub's
built-in `GITHUB_TOKEN` and OIDC.

## Repository contract

```text
.gardener/
├── gardener.json
├── gardener.lock.json
└── tasks/
    ├── bug-intake/TASK.md
    └── docs-helper/TASK.md

.github/workflows/
├── gardener-bug-intake.yml
└── gardener-docs-helper.yml
```

`TASK.md` is an authoring format only. `gardener build` strictly compiles it into canonical
`TaskBundleV1`, computes its SHA-256, and writes deterministic lock and workflow files. The runtime
never parses Markdown or YAML. See [Actions-native task authoring V1](docs/task-authoring-v1.md).

## Local scaffold and build

Requirements: Node.js 24+, pnpm 11.25.0, and a trusted Gardener checkout.

```bash
pnpm install

# Run these against the customer repository.
pnpm gardener -- init --demos --repository-root /path/to/repository
pnpm gardener -- build --repository-root /path/to/repository
```

`init` and `build` perform no network or remote mutation. They never overwrite task source or an
unmanaged GitHub workflow. Repeated builds produce byte-identical output.

The two bounded demos are:

- `bug-intake`, triggered by an opened issue labeled `gardener-bug`;
- `docs-helper`, triggered by an opened issue labeled `gardener-docs`.

Both may list/read repository files and propose one issue comment. Neither may run repository code.

## Headless Cloudflare deployment

Authenticate the existing vendor CLIs:

```bash
wrangler login
gh auth login
```

If an account-wide Cloudflare Access application protects all `workers.dev` hostnames, also provide
a narrowly scoped local token with **Access: Apps and Policies Edit** permission:

```bash
export CLOUDFLARE_API_TOKEN=...
```

The token is used only to create an exact-host bypass for the OIDC-authenticated runtime hostname. It
is never written to the repository, installation manifest, Worker, D1, GitHub, or command arguments.

From the trusted Gardener checkout:

```bash
pnpm gardener -- deploy \
  --workspace my-gardener \
  --source-root "$PWD"
```

`deploy` is checkpointed by an owner-only installation manifest under
`~/.config/gardener/<workspace>/actions/`. It creates or resumes deterministic resources, applies D1
migrations, deploys the single public runtime Worker, and verifies its narrow health endpoint.

The runtime exposes no dashboard or administrative API. Its only public routes are health and the
OIDC-authenticated bridge session endpoint.

## Connect a repository

After building the repository tasks:

```bash
pnpm gardener -- connect \
  --workspace my-gardener \
  --repository my-org/my-repository \
  --repository-root /path/to/repository \
  --source-root "$PWD"
```

`connect`:

1. resolves immutable repository and owner IDs through `gh`;
2. enrolls the exact repository and pinned reusable workflow in D1;
3. uploads canonical bundles keyed by SHA-256;
4. enables only those hashes for that repository;
5. sets the non-secret `GARDENER_RUNTIME_URL` GitHub repository variable.

Then commit the generated repository files normally:

```bash
cd /path/to/repository
git add .gardener .github/workflows
git commit -m "Add Gardener"
git push
```

## One-command composition

For a new repository project, `up` composes scaffold, build, deploy, connect, and doctor:

```bash
pnpm gardener -- up \
  --workspace my-gardener \
  --repository my-org/my-repository \
  --repository-root /path/to/repository \
  --source-root "$PWD" \
  --demos
```

It is safe to rerun. It never commits or pushes repository files. Existing projects keep their
pinned bridge release until explicitly upgraded.

To upgrade the runtime and one repository's bridge pin together:

```bash
pnpm gardener -- upgrade \
  --workspace my-gardener \
  --repository my-org/my-repository \
  --repository-root /path/to/repository \
  --source-root "$PWD"
```

Repeat the explicit upgrade for each connected repository. `doctor` reports enabled enrollments that
differ from the bridge release embedded in the running CLI.

## Qualify, diagnose, and tear down

After committing and pushing the generated workflows, run both demos and verify their exact GitHub
comments and D1 receipts:

```bash
pnpm gardener -- qualify \
  --workspace my-gardener \
  --repository my-org/my-repository \
  --repository-root /path/to/repository \
  --source-root "$PWD"

pnpm gardener -- doctor \
  --workspace my-gardener \
  --source-root "$PWD"

# First create and review a 24-hour, manifest-bound teardown intent.
pnpm gardener -- down --workspace my-gardener --source-root "$PWD"

# Then execute using the exact digest returned above.
pnpm gardener -- down \
  --workspace my-gardener \
  --source-root "$PWD" \
  --execute \
  --confirm <intent-digest>
```

## Current limitations

- The temporary demo package identity must be replaced before public npm publication.
- Actions V1 currently supports model-directed `repository.list_files` and `repository.read_file` tools only; `repository.exec` and non-empty network host rules fail compilation for this target.
- The current privileged effect surface is exactly `issue.comment.create`.
- Dashboard deployment through Cloudflare Access is optional and not yet part of the headless setup
  command.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:deploy
pnpm ui:check
```

Dependencies are exactly pinned. D1 is authoritative for enrollment, task bundles, runs, and receipts.
Flue and Workers AI remain the only model runtime.

## License

Apache-2.0
