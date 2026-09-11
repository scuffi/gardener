# Gardener — Agent-native product requirements

## Product goal

Gardener is a repository-stewardship product that customers deploy into their own Cloudflare account. A customer authors portable Gardener Agents in `AGENT.md`, reviews their structural capabilities, tests them without persistent effects, publishes immutable paused revisions, and explicitly activates and enables them. Gardener plans flexibly but can act only through policy-controlled, exact, typed GitHub operations executed by a credential-isolated Connect service.

This is a hard Agent-native cutover. The old form-defined automation product and its previous execution transport are not compatibility requirements.

## Current delivery status

The Agent contracts/compiler, data model, Computer workspace, model harness, OAuth MCP, management API, Agent-native dashboard, and deployment configuration are foundations under integration. One experimental generic-runtime slice now supports a bounded model-only proposal and automatic `issue.comment.create` effect for eligible issue-opened events through Connect V2. The general trusted tool/effect loop, approval waits, broader operation execution, and full real-resource staging remain incomplete; unsupported paths must continue to fail closed. See [`docs/foundation-status.md`](docs/foundation-status.md).

## Users and outcomes

An instance owner should be able to:

1. Start at managed Connect, authenticate with GitHub, choose App repositories, and deploy only Gardener with one copied instance secret.
2. Land in Inbox and see decisions, failures, drafts, regressions, and cleanup problems.
3. Describe an Agent, review/edit its exact `AGENT.md`, and inspect every requested capability.
4. Validate and simulate it without persistent effects.
5. Publish an immutable paused revision, activate it explicitly, and enable it separately.
6. Run multiple Agents and multiple tasks concurrently with isolated workspaces.
7. Answer typed, durable interruptions after disconnect/reconnect.
8. Understand what was observed, planned, approved, executed, retried, or rejected and why.
9. Pause all activity or one repository immediately.
10. Author the same portable package through dashboard, Git, CLI, or OAuth MCP without creating separate semantics.

## Deployment planes

### Customer Gardener

Gardener owns:

- dashboard, Inbox, owner session, and management API;
- Agent packages, drafts, immutable revisions, activation, and enablement;
- repository selection, capability policy, operation policy, and pauses;
- D1 event/run/task/step/interruption/grant/effect/receipt/audit records;
- one generic `AgentRunWorkflow`;
- AI binding and the Flue runtime adapter;
- isolated Cloudflare Computer workspaces;
- R2 snapshots and artifacts.

### Managed Connect

Connect owns:

- the shared GitHub App and all GitHub secrets/tokens;
- dashboard GitHub login and repository installation/discovery;
- raw webhook verification, normalization, and `RepositoryEventV2` signatures;
- Connect-attested observation and exact-SHA snapshot delivery;
- short-lived exact-operation grants;
- typed GitHub endpoint execution, live-state revalidation, idempotency, and receipts;
- instance/repository/installation/global revocation.

Connect is managed by default. Advanced customers may self-host the same independently deployed boundary.

## Agent package and authoring

`AGENT.md` is the canonical portable source. Strict YAML frontmatter declares exact triggers, immutable repository selectors, explicit observation/workspace/effect capabilities, eligibility, authority ceiling, limits, skills, and evals. Markdown describes behavior only.

Requirements:

- preserve exact source bytes, parsed semantics, compiled revision, provenance, hashes, and compiler/runtime/catalog versions;
- reject unknown fields/capabilities/actions, duplicate keys/paths, aliases, traversal, malformed UTF-8, oversized content, and missing package references;
- omitted capabilities mean none;
- compile `this` to an immutable repository ID;
- never interpolate repository/model/channel content as authority;
- use the same parser, compiler, semantic diff, simulation, and persistence API for every authoring channel;
- prompt generation may propose a package but cannot approve capabilities;
- Git provenance binds repository ID, commit SHA, and package path.

MCP is OAuth-protected and stateless. Its scopes permit read, validate, explain/diff, non-mutating simulation, paused-draft writes, and redacted traces only. It cannot publish revisions, activate, enable, change policy/repositories, approve, answer authority-bearing waits, or execute effects.

## Lifecycle and administration

- New Agents are disabled.
- Drafts are mutable and paused.
- Publication creates an immutable paused revision.
- Activation is an explicit owner action that changes the active revision.
- Enablement is a separate owner action.
- Activation/enablement cannot raise operation policy.
- Revisions show semantic differences in triggers, repositories, capabilities, behavior, limits, eligibility, skills, and evals.
- Global and repository pauses remain independent of Agent state.

## Events and eligibility

`RepositoryEventV2` supports GitHub issues, pull requests, comments, reviews, discussions, checks, pushes, releases, and trusted Gardener manual/scheduled requests. It preserves immutable repository/resource/actor IDs and separates the event actor from resource author.

Trusted eligibility runs outside the model against typed, bounded, versioned facts. Missing or unavailable authorization-sensitive facts fail closed. Team/role predicates require Connect-resolved facts and the necessary GitHub App permission; text and login strings are not identity proof.

Multiple matching Agents may be admitted for one event. One Agent may have simultaneous runs. There is no global Agent lock.

## Capabilities and policy

Authority is the intersection of:

- event/repository eligibility;
- compiled revision capability ceiling;
- instance policy;
- authoring authorization;
- any typed one-run grant;
- authenticated interruption decision;
- exact-effect approval;
- Connect live-state execution checks.

Safe observations and bounded workspace needs may be requested for one run. Repository expansion, new persistent effect kinds, broader actors, or higher authority require a new revision. Credentials, policy editing, bypass authority, and unrestricted repository access are never runtime-grantable.

Every effect kind has an independent `disabled`, `approval`, or `automatic` mode. Initially disable unrestricted networking, dependency installation, direct pushes, automatic code changes, and auto-merge. High-impact operations remain especially restrictive.

## Planning and acting

Planning may use the model and isolated workspace but cannot mutate GitHub. Harness tools can represent only observations and workspace actions. The planner emits typed requests, evidence, artifacts, task results, interruptions, or exact effect proposals.

Acting is model-free:

1. validate the strict operation;
2. persist its stable ID and canonical hash;
3. evaluate the immutable policy snapshot;
4. obtain exact approval where required;
5. ask Connect for a hash-bound grant;
6. re-fetch live provider state;
7. execute exactly once or classify retry/conflict/permanent failure;
8. persist a strict receipt.

A general plan approval is never blanket write authority. Every retry uses the same canonical payload and operation identity.

## Typed stewardship catalog

The product catalog covers:

- issue labels, comments, state, and assignees;
- PR comments, reviews, reviewer requests/removal, lifecycle updates, draft opening, and protected merge;
- branch and bounded commit creation;
- discussion comments, answers, and state;
- check reruns;
- release draft creation/update/publication/deletion.

Contracts use immutable IDs and expected state/SHA/timestamp preconditions. Commits are file/size/path bounded, never force push, and use a Gardener namespace. PR creation is draft-only. Protected merge requires exact head/base, non-draft/open state, required check identity and conclusion, allowed method, protection-state binding, and GitHub protection enforcement. Gardener must never be a bypass actor.

Catalog inclusion does not permit guessing GitHub APIs or permissions. Unsupported executors fail permanently and visibly until verified.

## Durable orchestration and parallelism

One generic `AgentRunWorkflow` serves all user Agents. Agent editing is data-only and requires no deploy.

Workflows owns durable continuation, deterministic retries, sleeps, waits, cancellation, and replay. D1 remains the authoritative product/audit record. R2 stores large inputs and outputs; Workflow state carries compact references.

Parallelism is default at four levels:

- matching Agents per event;
- simultaneous runs of one Agent;
- delegated tasks/subagents within a run;
- independent read-only or disjoint tool calls.

Each child gets task-specific context, capabilities, budget, and an isolated workspace. Child Agents have no independent persistent-effect authority. Parent/child joins are persisted in D1. Authoritative orchestration permits deterministic `Promise.all` groups but prohibits `Promise.race`/`Promise.any` selection.

## Computer execution

Use `@cloudflare/computer` with the hierarchy: Connect-attested observations, durable filesystem, local-only typed Git, Worker shell, Worker JavaScript, and lazy Container.

Requirements:

- workspace IDs derive from immutable instance/run/task/principal identity;
- exact-SHA, credential-free inputs and no credentialed remote;
- local Git rejects clone/fetch/pull/push/`ls-remote` and network configuration;
- shell is `just-bash`; package managers/native tools need Container;
- Container defaults to Ask per run;
- Container, network, and dependency installation are separate grants;
- egress is denied by default and DNS/IP resolution is checked by trusted code when networking is later supported;
- bounded time/output/source/disk/files/diff/artifacts;
- unresolved synchronization blocks artifact freezing;
- ambiguous executions are not automatically replayed;
- cleanup uses leases, retries, reconciliation, and visible Inbox failure.

Computer is preview-only and code execution remains experimental until real platform tests pass.

## Harnesses and models

Flue is Gardener's only product Agent runtime. It is selected by host code, never by Agent prose or an instance setting. Each run pins the Flue adapter ID/version, and one static generic Flue Agent executes all user-authored Agent revisions as immutable data. Gardener retains a framework-neutral internal request/submission/outcome contract so a future runtime pivot remains an adapter change rather than a product-authority change.

The standard deployment uses Flue with the Cloudflare AI binding and current AI Gateway routing support; no model-provider secret is required. Gardener exposes no generic AI SDK harness and performs no automatic runtime fallback.

Adapters must pass the same conformance suite for identity binding, structured output, budgets, tool narrowing, cancellation, errors, and no persistent authority expansion. Preview/experimental failures are typed and fail closed.

## Inbox and observability

Inbox is the canonical owner decision surface. It includes typed interruptions, exact-effect approvals, blocked/failed runs, drafts awaiting activation, eval regressions, and workspace cleanup failures.

Run pages show nested parallel tasks/steps, model/workspace usage, redacted evidence/artifacts, waits, effects, receipts, retries, and cancellation. Traces explain; audit records and receipts prove. Redacted real runs may become versioned eval fixtures, but model/eval scores may block or request review and never authorize an effect.

Notification channels are adapters only. Freeform Slack, email, issue comments, GitHub comments, or model-readable text cannot confer authority.

## Authentication and optional Access

Dashboard sign-in, GitHub App installation, instance authentication, OAuth MCP credentials, and runtime grants are distinct.

Cloudflare Access is optional defense in depth. When used, one full-host Access application has a human Allow policy and a Connect-specific Service Auth policy. There is no `/hooks/connect` bypass. Access admission never replaces the Gardener owner session or signed Connect event verification.

## Destructive cutover

The production cutover deletes old automation definitions/revisions/events/runs/proposals/results/audit data without export. It retains repositories, instance settings/owner authentication state where applicable, and operation-policy modes. No compatibility runtime or legacy fallback survives. New Agents are created as disabled/paused objects after cutover.

The reset occurs only after exhaustive validation and owner acknowledgement.

## Acceptance criteria

- One-secret managed deployment and multi-repository owner onboarding work from a public source.
- No GitHub/provider credential reaches Gardener, source control, browser APIs, prompts, MCP clients, tools, logs, URLs, or Computer.
- All authoring channels compile identical bytes/semantics into immutable paused revisions.
- Activation and enablement require separate owner actions.
- Events can admit multiple parallel Agents without shared writable workspaces.
- Interruptions survive disconnects and reject expiry, wrong responder, wrong nonce, changed payload, and replay.
- Every effect is exact-hash-bound, persisted, policy-checked, live-revalidated, and receipted.
- Pause, revocation, stale-state conflict, cancellation, retry, and cleanup work under real Cloudflare staging.
- Inbox and run details pass keyboard, Axe, light/dark, desktop/mobile, and 400% zoom/reflow review.
- Fresh install and destructive upgrade are tested; no old automation code/data remains.
- Full tests, typechecks, builds, dry runs, security review, GitHub permission review, and production verification pass before traffic moves.

## Non-goals

- Credentials or arbitrary privileged plugins in Agent packages.
- Unrestricted shell/network/dependency installation.
- Direct credentialed Git pushes from workspaces.
- Branch-protection or ruleset bypass.
- Model-scored authorization.
- Per-Agent Worker classes or deployments.
- GitLab in the initial cutover.
- An SLA claim for preview Computer or experimental Flue dependencies.
