# Gardener

Gardener is an Agent-native repository steward that customers deploy into their own Cloudflare account. Gardener Agents are portable `AGENT.md` packages: Markdown describes judgment and behavior, while strict structural capabilities, instance policy, human decisions, and managed Connect determine authority.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/scuffi/gardener)

> **Experimental bounded runtime:** Gardener now admits enabled Agent revisions into one generic `AgentRunWorkflow` and runs planning through one generic Flue Agent. It supports one deliberately narrow live path: `github.issue.opened` → a model-only structured proposal → a host-constructed, automatic-policy `issue.comment.create` exact effect → Connect V2 receipt. The path uses immutable snapshots, strict budgets, live policy/pause revalidation, deterministic IDs, and durable retries. Approval-mode effects, harness tools, Computer/Container execution, child tasks, waits, and the rest of the operation catalog remain fail closed and are not production-ready. See [Foundation status](docs/foundation-status.md).

## Deployment boundaries

This monorepo contains two independently deployed Workers:

- **`apps/connect` — managed Gardener Connect.** The Gardener operator holds the shared GitHub App credentials, verifies webhooks, signs `RepositoryEventV2` envelopes, mints narrowly scoped grants, and executes strict typed GitHub operations. It is the only component that may hold GitHub installation tokens.
- **`apps/gardener` — customer Gardener.** The customer owns Agents, immutable revisions, policies, runs, interruptions, effects, receipts, audit history, the dashboard, model usage, Computer workspaces, and artifacts in their Cloudflare account.
- **`packages/contracts`** defines strict Agent, event, capability, policy, interruption, run, and operation schemas.
- **`packages/core`** parses and compiles `AGENT.md`, resolves repository selectors to immutable IDs, creates stable hashes, evaluates trusted eligibility, and evaluates policy.

The normal human flow remains:

```text
Gardener → managed Connect → shared Gardener GitHub App → Gardener owner session
```

GitHub credentials never enter the customer Worker, browser, model prompt, MCP client, Agent package, Computer workspace, or local tool. Self-hosting Connect is an [advanced operating mode](docs/self-hosted-connect.md), not an onboarding requirement.

## Product model

An owner creates an Agent by describing it in the dashboard, editing `AGENT.md`, publishing through Git, or using the draft-only OAuth MCP server. Every channel uses the same source parser, compiler, simulation, revision, and management boundaries.

The lifecycle is deliberately multi-step:

1. Edit a mutable, paused draft.
2. Review strict requested capabilities and simulate without persistent effects.
3. Publish an immutable **paused** revision.
4. Explicitly activate that revision.
5. Separately enable the Agent.

Agent instructions cannot grant repositories, credentials, network access, tools, effect kinds, or policy modes. Omitted capabilities mean none. Unknown keys, trigger names, capabilities, operations, and package paths fail validation.

At runtime, the target design uses one generic Cloudflare `AgentRunWorkflow` for every Agent revision. D1 is authoritative; Workflows owns durable continuation, retry, sleep, waits, cancellation, and replay. Independent runs and child tasks execute in parallel by default, while each writable run/task/principal receives an isolated Cloudflare Computer Durable Object workspace.

Read [Agent authoring](docs/agent-authoring.md), [Architecture](docs/architecture.md), and [Security](SECURITY.md).

## Managed deployment

The intended public deployment deploys **Gardener only**; managed Connect already exists. The only required secret is the one-time `GARDENER_INSTANCE_TOKEN` created by Connect. The AI binding is used directly, including current AI Gateway model routing support, so the standard path does not require a model-provider secret.

The repository is currently private, and Cloudflare deploy buttons require a public GitHub or GitLab source. The button above is not usable by external customers until the source is public. The root deployment configuration now describes the same Agent-native resources as `apps/gardener/wrangler.jsonc`; nevertheless, do not claim one-click deployment until the runtime foundation, real-resource staging checks, and public-source release gate are complete.

Optional Cloudflare Access protection is defense in depth. It uses one full-host application with a human Allow policy and a dedicated Connect Service Auth policy; there is no public `/hooks/connect` bypass. See [Optional Cloudflare Access](docs/cloudflare-access.md).

## Local development

Requirements: Node.js 22+, pnpm 11.25.0, and a Cloudflare account.

```bash
pnpm install
cp apps/connect/.dev.vars.example apps/connect/.dev.vars
cp apps/gardener/.dev.vars.example apps/gardener/.dev.vars
pnpm --filter @gardener/connect db:migrate:local
pnpm --filter @gardener/app db:migrate:local
```

Run the two Workers separately:

```bash
pnpm --filter @gardener/connect exec wrangler dev --port 8788
pnpm --filter @gardener/app exec wrangler dev --port 8787
```

`LOCAL_DEV_BYPASS=true` is for private local development only. It must never be enabled on a public deployment.

## Validation

```bash
pnpm check
```

The complete Agent-native release gate is broader than this command: package tests and typechecks, Worker dry runs, migration tests, browser and accessibility review, deployed Workers AI, Workflows, Dynamic Worker, Durable Object, R2, and Container staging tests, Connect/GitHub permission verification, and exact-effect end-to-end tests must all pass. The Agent-native onboarding smoke validates local authoring lifecycle separation, Authorization-only bounded run admission, validation-only simulation, responsive reflow, light/dark rendering, keyboard focus, and serious/critical Axe checks; it does not substitute for real Cloudflare staging.

Dependencies are exactly pinned. Cloudflare Computer is preview-only and Flue is experimental. Flue is Gardener's only product runtime, while the framework-neutral harness contract remains an internal portability boundary. See [Version policy](docs/version-policy.md).

## Destructive cutover

The Agent-native schema intentionally removes old automation objects without export: old definitions, revisions, events, runs, proposals, results, and audit rows are deleted. Repository selections, instance settings/owner state where applicable, and operation policy modes are retained. Apply the reset only after review and deployment preparation; see [Foundation status](docs/foundation-status.md).

## License

Apache-2.0
