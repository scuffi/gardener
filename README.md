# Gardener

Gardener is an Agent-native repository steward that a team deploys into its own Cloudflare account.
Portable `AGENT.md` revisions describe behavior and requested capabilities; structural assignments,
versioned policy, live state, and provider permissions determine authority.

> **Experimental bounded runtime:** the qualified path is intentionally narrow:
> `github.issue.opened` → one native Flue turn → `submit_gardener_output_v1` → a host-constructed
> `issue.comment.create` → a hash-bound GitHub Gateway receipt. Approval effects, general trusted
> tools, Computer workspaces, and multi-effect work remain fail closed. See [Foundation status](docs/foundation-status.md).

## Customer-owned deployment

One deployment is one team workspace and consists of:

- **`apps/gardener`** — the control plane and Agent runtime. Its D1 owns users, owner/member
  memberships, invitations, opaque sessions, Agents, assignments, policy, runs, effects, Inbox,
  receipts, and audit history.
- **`apps/github-gateway`** — a dedicated single-workspace provider boundary. Its D1 owns OAuth and
  installation flows, installation/repository discovery, verified webhook deliveries, and provider
  operation receipts. It alone holds GitHub credentials and short-lived installation tokens.
- **`packages/provider-github`** — strict private RPC contracts shared by those Workers. It declares
  all 29 operation kinds and reports exactly 12 verified executors as available.
- **`packages/contracts`** and **`packages/core`** — provider-neutral product schemas, portable Agent
  compilation, stable hashes, eligibility, policy, and overlap analysis.
- **`packages/cli`** — checkpointed Gateway provisioning, diagnostics, and explicit delivery retry.

The Workers communicate through named Cloudflare Service Binding RPC entrypoints:

```text
Browser -> Gardener -> GitHubGatewayEntrypoint
GitHub -> Gateway webhook -> Gateway D1 -> waitUntil -> GardenerGitHubEntrypoint
Gardener runtime -> Gateway executeOperation RPC -> GitHub
```

There is no central Gardener service, shared customer database, shared App, instance bearer token,
identity JWT, JWKS endpoint, or public provider-operation API. GitHub App credentials never enter
Gardener, Flue, MCP, model input, URLs, logs, generated config, or Computer workspaces.

## Product model

One D1 database is one workspace. Gardener owns provider-neutral users and exactly two roles:
`owner` and `member`. The permanent owner is seeded by immutable numeric GitHub user ID before OAuth
login is enabled. Members may propose and narrow; owners alone create or widen live authority.

An Agent lifecycle is deliberately multi-step:

1. Edit a mutable paused draft.
2. Review requested capabilities and simulate without persistent effects.
3. Publish an immutable paused revision.
4. Explicitly activate that revision.
5. Separately create and enable exact-repository assignments.

Assignments are the only runtime enablement gate. New assignments are disabled. Fresh installations
include three system-published starter revisions—Issue triage, Bug intake, and Documentation helper—
with active revision pointers but no repository assignments, so they have no runtime authority until
an owner explicitly assigns and enables one. “All current” materializes current repository IDs and
never follows future repositories. Missing repository policy means nothing runs. Effective authority
is the most restrictive intersection of workspace, repository, Agent, assignment, provider, and live
state.

Read [Agent authoring](docs/agent-authoring.md), [Architecture](docs/architecture.md),
[GitHub Gateway operations](docs/github-gateway.md), and [Security](SECURITY.md).

## Setup

Requirements: Node.js 24+, pnpm 11.25.0, Wrangler authentication, and a Cloudflare account.

### Manual setup

From a trusted, reviewed checkout:

```bash
pnpm install
pnpm check

# Personal GitHub App
pnpm gardener -- setup \
  --workspace my-team \
  --owner my-github-login \
  --personal

# Or organization-owned GitHub App
pnpm gardener -- setup \
  --workspace my-team \
  --owner my-github-login \
  --organization my-organization
```

`gardener setup` is the normal V1 entry point. Before remote mutation it identifies the Cloudflare
account, resolves the permanent owner's immutable numeric GitHub ID, rejects deterministic name
collisions, shows a plain-English resource summary, runs all three generated Worker configurations
through `wrangler deploy --dry-run`, and asks for a final yes/no confirmation. Infrastructure output
stays quiet unless a command fails; pass `--verbose` to show the underlying build and Wrangler output.
The guided output uses restrained semantic colours in interactive terminals and respects `NO_COLOR`.
If account-wide Cloudflare Access is enabled, setup verifies both Workers through the operator's
`cloudflared` identity, keeps Gardener protected, and explains that the Gateway must be made public
for GitHub webhooks and callbacks before final verification can pass.

The checkpointed apply then:

1. provisions two D1 databases and the Gardener R2 bucket;
2. deploys a credential-free Gateway shell and applies its migration;
3. deploys Gardener with its outbound named RPC binding and applies its migrations, including safe unassigned starter Agents;
4. seeds the confirmed permanent owner;
5. redeploys the Gateway with its reverse named RPC binding;
6. opens the personal or organization GitHub App Manifest form in the human browser;
7. uploads credentials directly to Gateway secrets through stdin;
8. verifies App credentials, both RPC directions, capabilities, and delivery state.

Temporary manifest credentials are kept only in
`~/.config/gardener/<workspace>/setup-recovery.json` with mode `0600` and deleted after verification.
The independent operator token remains in an owner-only local file for diagnostics and retry. Rerun
the same setup command after interruption; do not inspect or manually rewrite recovery state.
Workers.dev origins are the supported V1 deployment shape.

### Coding-agent setup

The automatic path deliberately runs the same CLI rather than giving an agent a second provisioning
implementation. Copy the prompt in [Set up Gardener with a coding agent](docs/setup-with-coding-agent.md)
into a trusted coding agent. It asks for the workspace, immutable owner, and App ownership; runs local
validation; displays the exact plan; obtains confirmation; starts `gardener setup` interactively; and
runs doctor/smoke afterward. GitHub Manifest approval remains a human browser action.

The coding agent must never read or place `.dev.vars`, setup recovery, private keys, client secrets,
webhook secrets, operator tokens, App JWTs, or installation tokens into model context, argv, URLs,
logs, or generated configuration.

### Validation and operation

```bash
# Local generated-topology dry run; no Cloudflare or GitHub mutation.
pnpm gardener -- gateway plan --workspace qual-local-dry-run

# Read-only checks against an initialized live stack.
pnpm gardener -- gateway doctor --workspace my-team
pnpm gardener -- gateway smoke --workspace my-team
pnpm gardener -- gateway retry <github-delivery-id> --workspace my-team
```

Disposable qualification uses `gateway qualify --workspace qual-<name>`. It performs real setup and
always attempts guarded Cloudflare teardown; deleting the GitHub App remains an explicit owner action.
`gateway destroy` defaults to a dry run and can execute only against checkpoints created with
`--qualification` and a `qual-*` workspace name. See the Gateway runbook for the exact commands.

Setup and tests never delete or replace an existing deployment. Development workspace `dev` is the
fresh V1 stack; its deterministic resources are created only after the setup plan is confirmed.

## Local development

```bash
cp apps/github-gateway/.dev.vars.example apps/github-gateway/.dev.vars
cp apps/gardener/.dev.vars.example apps/gardener/.dev.vars
pnpm --filter @gardener/github-gateway db:migrate:local
pnpm --filter @gardener/app db:migrate:local
```

Run the Workers separately with local Service Bindings configured by Wrangler:

```bash
pnpm dev:gateway
pnpm dev
```

`LOCAL_DEV_BYPASS=true` is private-local-development only and must remain false publicly.

## Validation

```bash
pnpm check
```

The release gate also requires migration fixtures, browser/accessibility review, dry deployment of
both Workers, and explicit real Cloudflare/GitHub qualification of circular named bindings,
personal and organization Apps, multiple installations, webhook failure/retry, and exact operation
replay. Unchanged Computer deployments use `--containers-rollout none`.

Dependencies are exactly pinned. Cloudflare Computer is preview-only and Flue remains experimental.
D1 is authoritative for product state; Flue is the Agent runtime. Ordinary runs use no Cloudflare
Workflow. A bounded D1/Cron reconciler closes dispatch and abnormal-settlement gaps.

## License

Apache-2.0
