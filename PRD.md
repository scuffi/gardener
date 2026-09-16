# Gardener — Agent-native product requirements

## Product goal

Gardener is a repository-stewardship product that teams deploy into their own Cloudflare account. A customer authors portable, repository-independent Gardener Agents in `AGENT.md`, reviews their structural capabilities, tests them without persistent effects, publishes immutable paused revisions, activates one revision workspace-wide, and separately assigns it to repositories. Gardener plans flexibly but can act only through policy-controlled, exact, typed GitHub operations executed by that workspace's customer-owned credential-isolated GitHub Gateway.

This is a hard Agent-native cutover. The old form-defined automation product and its previous execution transport are not compatibility requirements.

## Current delivery status

The Agent contracts/compiler, data model, Computer workspace, model harness, OAuth MCP, management API, Agent-native dashboard, customer-owned GitHub Gateway, and focused infrastructure CLI are foundations under integration. One experimental Flue-native slice supports a bounded one-turn terminal-tool proposal and automatic `issue.comment.create` effect for eligible issue-opened events through private Gateway RPC. The general trusted tool/effect loop, approval waits, broader runtime execution, and full real-resource staging remain incomplete; unsupported paths must continue to fail closed. See [`docs/foundation-status.md`](docs/foundation-status.md).

## Users and outcomes

An instance owner should be able to:

1. Run a transparent, resumable CLI that deploys Gardener plus a dedicated Gateway/D1/App in the customer's accounts.
2. Land in Inbox and see decisions, failures, drafts, regressions, and cleanup problems.
3. Describe an Agent, review/edit its exact `AGENT.md`, and inspect every requested capability.
4. Validate and simulate it without persistent effects.
5. Publish an immutable paused revision, activate it explicitly, and separately create/enable exact-repository assignments.
6. Run multiple Agents and multiple tasks concurrently with isolated workspaces.
7. Answer typed, durable interruptions after disconnect/reconnect.
8. Understand what was observed, planned, approved, executed, retried, or rejected and why.
9. Pause all activity or one repository immediately.
10. Author the same portable package through dashboard, Git, CLI, or OAuth MCP without creating separate semantics.

## Deployment planes

### Customer Gardener

Gardener owns:

- dashboard, Inbox, provider-neutral users, owner/member memberships, invitations, revocable opaque sessions, and management API;
- Agent packages, drafts, immutable revisions, global activation, and structural repository assignments;
- repository inventory, workspace/repository capability and operation policy, and pauses;
- D1 event/run/interruption/grant/effect/receipt/audit records, including historical task/step rows;
- one static Flue Agent plus a bounded D1/Cron convergence outbox;
- AI binding and the Flue-native runtime driver;
- isolated Cloudflare Computer workspaces;
- R2 snapshots and artifacts.

### Customer GitHub Gateway

Each workspace's Gateway owns:

- one customer-owned GitHub App and its secrets/tokens;
- GitHub OAuth identity proof and installation/repository discovery;
- raw webhook verification, normalization, durable delivery, and canonical event hashes;
- direct private event delivery to Gardener through a named Service Binding;
- typed GitHub endpoint execution, live provider preconditions, idempotency, and receipts;
- installation/repository suspension and revocation state.

The Gateway is customer-deployed by default. It has one workspace D1, no tenant columns, no shared issuer or instance token, and no public provider-execution API. A future managed implementation may implement the same contract but is not a Gardener dependency.

## Agent package and authoring

`AGENT.md` is the canonical portable, repository-independent source. Strict YAML frontmatter declares exact triggers, explicit observation/workspace/effect capabilities, eligibility, an effect authority ceiling, limits, skills, and evals. Markdown describes behavior only. `repositories`, `this`, repository selectors/expansion, and repository provenance are not part of `gardener.agent/v1`.

Requirements:

- preserve exact source bytes, parsed semantics, compiled revision, supporting-file hashes, and compiler/runtime/catalog versions;
- reject unknown fields/capabilities/actions, duplicate keys/paths, aliases, traversal, malformed UTF-8, oversized content, and missing package references;
- omitted capabilities mean none;
- never interpolate repository/model/channel content as authority;
- use the same parser, compiler, semantic diff, simulation, and persistence API for every authoring channel;
- prompt generation may propose a package but cannot approve capabilities.

MCP is OAuth-protected and stateless. Its scopes permit read, validate, explain/diff, non-mutating simulation, paused-draft writes, and redacted traces only. It cannot publish revisions, activate, create/change assignments, change policy/repositories, approve, answer authority-bearing waits, or execute effects.

## Lifecycle and administration

- Drafts are mutable and paused.
- Publication creates an immutable paused revision.
- Activation is an explicit owner action that changes the workspace-global active revision.
- Repository assignment is separate, versioned, structural, and disabled by default.
- Global activation plus an enabled, non-removed assignment for the exact repository is the sole enable gate.
- “All current” atomically materializes the exact current active repository IDs; it is not a selector and never follows future repositories.
- Activation/assignment cannot raise policy.
- Revisions show semantic differences in triggers, capabilities, behavior, limits, eligibility, skills, and evals.
- Global and repository pauses remain independent admission controls.

## Events and eligibility

`RepositoryEventV2` supports GitHub issues, pull requests, comments, reviews, discussions, checks, pushes, releases, and trusted Gardener manual/scheduled requests. It preserves immutable repository/resource/actor IDs and separates the event actor from resource author.

Trusted eligibility runs outside the model against typed, bounded, versioned facts. Missing or unavailable authorization-sensitive facts fail closed. Team/role predicates require provider-resolved immutable subjects and the necessary GitHub App permission; text and login strings are not identity proof.

Multiple matching Agents may be admitted for one event. One Agent may have simultaneous runs. There is no global Agent lock.

## Capabilities, assignments, and policy

Persistent-effect authority is the most restrictive of event/repository eligibility, workspace policy ceiling, repository policy, compiled revision effect ceiling, assignment authority ceiling, authoring authorization, any typed one-run grant, authenticated interruption decision, exact-effect approval, and Gateway/provider live-state checks. Admission snapshots this authority; live restrictions apply immediately, while later widening never upgrades an in-flight run. Missing, partial, or invalid repository policy fails closed.

Observation and workspace capabilities are intersected separately with the revision and workspace/repository capability policy. Workspace-local capabilities are not gated by the assignment's persistent-effect authority ceiling.

Overlapping Agents are allowed. Assignment and activation changes warn when enabled Agents on the same repository intersect on both triggers and requested persistent effects; confirmation requires a fresh state-bound fingerprint. This warning performs no hidden arbitration: all matching eligible Agents are independent.

Safe observations and bounded workspace needs may be requested for one run. New persistent effect kinds, broader actors, or higher authority require a new revision; repository access requires an assignment change. Credentials, policy editing, bypass authority, and unrestricted repository access are never runtime-grantable.

Every effect kind has an independent `disabled`, `approval`, or `automatic` mode. Initially disable unrestricted networking, dependency installation, direct pushes, automatic code changes, and auto-merge. High-impact operations remain especially restrictive.

## Planning and acting

Planning may use the model and isolated workspace but cannot mutate GitHub. Harness tools can represent only observations and workspace actions. The planner emits typed requests, evidence, artifacts, task results, interruptions, or exact effect proposals.

Acting is model-free:

1. validate the strict operation;
2. persist its stable ID and canonical hash;
3. evaluate the immutable policy snapshot;
4. obtain exact approval where required;
5. call the private Gateway with the exact operation, run, and delivered event binding;
6. re-fetch live provider state;
7. execute exactly once or classify retry/conflict/permanent failure;
8. persist and verify a hash-bound strict receipt.

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

One static Flue Agent serves all user Agents. Agent editing is data-only and requires no deploy. Ordinary Agent runs do not create Cloudflare Workflow instances.

Flue owns conversations, submissions, model turns, durable tools, subagents, recovery, and abort. D1 remains authoritative for admission, frozen authority, canonical output, exact effects and receipts, cancellation intent, product status, and audit. A bounded model-free Cron reconciler repairs only dispatch and abnormal-settlement gaps; it is not another run state machine. R2 stores large inputs and outputs.

Parallelism is available at four levels:

- matching Agents per event;
- simultaneous runs of one Agent;
- delegated tasks/subagents within a run;
- independent read-only or disjoint tool calls.

Each child gets task-specific context, capabilities, budget, and an isolated workspace. Child Agents have no independent persistent-effect authority. Parent/child joins are persisted in D1. Authoritative orchestration permits deterministic `Promise.all` groups but prohibits `Promise.race`/`Promise.any` selection.

## Computer execution

Use `@cloudflare/computer` with the hierarchy: Gateway-attested observations, durable filesystem, local-only typed Git, Worker shell, Worker JavaScript, and lazy Container.

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

Flue is Gardener's only product Agent runtime. It is selected by host code, never by Agent prose or an instance setting. Each run pins immutable `runtime_driver` and product-adapter tags, and one static generic Flue Agent executes user-authored Agent revisions as data. `harness_requests` stores frozen requests and `harness_submissions` stores accepted receipts; Gardener does not maintain a generic interchangeable runtime lifecycle.

The standard deployment uses Flue with the Cloudflare AI binding and current AI Gateway routing support; no model-provider secret is required. Native provider mode preserves Flue's serialized tools while bounding the final payload, output tokens, and absolute deadline. Gardener performs no automatic runtime fallback.

The qualified profile permits one model turn and one trusted terminal tool. Missing terminal output fails rather than appending another model turn. Multi-turn profiles require separate aggregate-budget qualification. Preview/experimental failures remain typed and fail closed.

## Inbox and observability

Inbox is the canonical workspace decision surface. It includes typed interruptions, exact-effect approvals, blocked/failed runs, drafts awaiting activation, eval regressions, and workspace cleanup failures.

Run pages show nested parallel tasks/steps, model/workspace usage, redacted evidence/artifacts, waits, effects, receipts, retries, and cancellation. Traces explain; audit records and receipts prove. Redacted real runs may become versioned eval fixtures, but model/eval scores may block or request review and never authorize an effect.

Future channels are adapters over durable Inbox/run/output events only. Credentials and destinations are structural and model-invisible; authenticated, nonce-bound responses terminate in the existing interruption decision service, with Inbox and D1 authoritative. No channels schema, API, runtime, or UI is implemented, and Slack/Teams have neither runtime credentials nor blanket approval. Freeform channel text cannot confer authority.

## Authentication and optional Access

Dashboard sign-in, GitHub App installation, local sessions, OAuth MCP credentials, and runtime authority are distinct. One deployment/D1 is one workspace. The Gateway completes a random, hash-stored one-use login handoff through private RPC; Gardener consumes it into a hashed, opaque, revocable local session and owns provider-neutral users, immutable external-subject links, memberships, and invitations. The preseeded owner membership is permanent. Members may propose and narrow; only owners activate, add/enable/expand assignments, approve, widen policy, manage members, synchronize repositories, or manage installation. MCP revalidates active membership per request and cannot use its principal kind to reach dashboard-only authority.

Cloudflare Access is optional defense in depth. A full-host human Allow policy may protect Gardener, but Service Bindings—not Access service tokens—protect Gateway RPC. Access admission never replaces Gardener's opaque workspace session, active-membership/role checks, or Gateway webhook verification.

## Destructive cutover

The clean pre-V1 v7 cutover intentionally deletes old test Agents and run/runtime evidence without export so Agent V1 has one repository-independent meaning. It retains repositories, settings, owner state, and policy modes. No compatibility runtime or legacy fallback survives; new deployments start from paused drafts and disabled assignments.

The reset occurs only after exhaustive validation and owner acknowledgement, with execution paused, zero non-terminal runs, reviewed count/hash/key manifests, guarded v6 migration statements, legacy Workflow/DO/R2/workspace cleanup, and post-cutover retained-state verification. Gardener v7 and the Gateway are implemented locally but not yet deployed. Release requires local review, explicit approval, fresh-stack Gateway qualification, migration verification, and a final paused state; see [ADR 0001](docs/adr/0001-team-workspace-and-agent-deployments.md).

## Acceptance criteria

- Checkpointed customer-owned deployment and multi-installation owner onboarding work from a reviewed source.
- No GitHub/provider credential reaches Gardener, source control, browser APIs, prompts, MCP clients, tools, logs, URLs, or Computer.
- All authoring channels compile identical bytes/semantics into immutable paused revisions.
- Revision activation and repository assignment/enablement require separate owner actions.
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
