# Gardener Agent-native architecture

## Status

This document describes the target architecture and identifies what exists in the current foundation. The current `AgentRunWorkflow` implements one experimental end-to-end slice: an immutable issue-opened event can produce a bounded model-only comment proposal and, under automatic policy, one host-constructed exact `issue.comment.create` effect through Connect V2. Tools, workspaces, approvals, multi-effect plans, and other event/operation kinds remain fail closed.

## Two independent deployment boundaries

```text
GitHub ── webhook ──▶ managed Connect ── signed RepositoryEventV2 ──▶ customer Gardener
  ▲                         ▲                                         │
  │                         └──── hash-bound grant + typed effect ────┘
  └──────── GitHub installation token exists only in Connect
```

### Managed Connect

`apps/connect` is centrally operated by default. It owns the shared GitHub App, OAuth secret, webhook secret, signing key, installation discovery, normalized event attestation, installation-token minting, live GitHub revalidation, and typed operation execution. It never exposes a raw GitHub proxy or installation token.

Advanced customers may operate the same boundary themselves. Self-hosting changes the operator, not the contract or credential-isolation rule.

### Customer Gardener

`apps/gardener` owns provider-neutral users, owner/member memberships and invitations, opaque dashboard sessions, repository inventory and structural assignments, Agent packages, mutable drafts, immutable revisions, the workspace-global active revision pointer, policy, Inbox decisions, events, runs, tasks, steps, interruptions, temporary grants, effect intents, receipts, leases, artifacts, and audit history.

Gardener has an AI binding but no GitHub credential. Standard deployment needs no model-provider secret. Host code always selects Gardener's Flue adapter; the immutable run snapshot pins the Flue harness ID and adapter version.

## Authority layers

These layers remain separate and fail closed:

1. **Admission:** global/repository pause, one workspace-global active immutable revision, an enabled non-removed structural assignment for the event's exact repository, and a complete valid repository policy. Assignment is the sole enable gate; Agent-level enabled state is not authoritative.
2. **Event eligibility:** a `RepositoryEventV2` trigger, immutable repository ID, and trusted actor/resource facts.
3. **Revision capability ceiling:** capabilities explicitly requested by the compiled, repository-independent Agent revision.
4. **Workspace and repository policy:** observations and workspace/effect modes (`disabled`, `approval`, `automatic`); missing, partial, malformed, or unhashable repository policy fails closed.
5. **Authoring authorization:** an authorized opaque dashboard session or OAuth MCP scopes; authoring never implies runtime authority.
6. **One-run grants:** narrowly scoped, expiring approvals for grantable observation/workspace needs.
7. **Typed interruption:** authenticated, responder-bound, nonce-bound human input or decision.
8. **Exact-effect decision:** one canonical operation payload and hash, never a blanket plan approval.
9. **Connect execution:** event/grant/repository/resource binding, live-state preconditions, provider permissions, idempotency, and receipt.

Repository content, comments, model output, Agent prose, channel messages, and eval scores may influence planning but never authorize an effect.

## Authoring and immutable data

`AgentSourceV1` preserves the exact bytes of `AGENT.md` and supporting files as canonical base64. The parser separately produces strict semantics. `gardener.agent/v1` source and compiled behavior are repository-independent: there is no `repositories` field, `this` shorthand, repository selector, expansion, or repository provenance. Compilation records source, semantic, referenced-file, compiler, catalog, and runtime identities only.

Drafts remain mutable and paused. Publication creates an immutable paused revision. Owner activation changes the one workspace-global active revision pointer. Repository deployment is a separate, versioned structural assignment that is disabled by default. Only an active revision plus an enabled, non-removed assignment for the event's exact repository can admit a run. A run binds `CompiledAgentRevisionV1`, its exact assignment and repository policy, effective capabilities, workspace policy, harness, budgets, and all component versions in `AgentRunSnapshotV1`.

Dashboard, direct Markdown, Git-native publication, CLI clients, and OAuth MCP are intended to call the same canonical services. MCP currently exposes only read, validate, explain, diff, simulation, paused-draft, and redacted-trace tools.

## Durable run model

The target runtime has one deployed generic `AgentRunWorkflow`; user Agent creation is a data operation and never creates a Worker class or Wrangler deployment.

D1 is authoritative for:

- Agents, drafts, revisions, global activation, structural repository assignments, and assignment history;
- normalized events and admission decisions;
- runs, parallel tasks, durable steps, usage, and errors;
- interruptions and one-run capability grants;
- effect intents, canonical operation hashes, approvals, and receipts;
- Inbox items, evals, artifacts, and workspace cleanup leases.

Cloudflare Workflows owns durable continuation, deterministic step retry, sleeps, waits, cancellation, and replay. Large snapshots, patches, transcripts, logs, and tool output are referenced from host-controlled R2 instead of being embedded in Workflow state. Promise-based parallel groups must be deterministic; authoritative orchestration must not use `Promise.race()` or `Promise.any()` because losing work continues and replay selection can diverge.

The current entrypoint supports one bounded Flue model-only proposal followed by a host-constructed automatic `issue.comment.create` exact effect. General tools, approval waits, child joins, broader effects, and cleanup sequencing remain release blockers.

## Computer workspaces

`@cloudflare/computer` is the primary execution abstraction:

1. Connect-attested observation;
2. durable Computer filesystem;
3. local-only typed Git;
4. Worker shell (`just-bash`, not full Linux);
5. Worker JavaScript;
6. lazy Container fallback.

Every writable principal gets a workspace ID derived from immutable instance/run/task/principal identity. Parallel tasks never share one writable workspace. Inputs are credential-free snapshots bound to an exact SHA, hydrated by trusted host code or mounted read-only from R2. The workspace has no credentialed remote.

Local Git rejects network-bearing operations such as clone, fetch, pull, push, and `ls-remote`. Worker execution uses denied egress. Container is **Ask per run** by default and starts lazily. Container authorization does not grant networking or dependency installation; those require separate capabilities and instance policy. Unresolved Container-to-Durable-Object synchronization blocks patch/artifact freezing. Execution IDs, hashes, durable results, ambiguous-result classification, cleanup leases, and a sweeper prevent unsafe replay and abandoned state.

Computer `0.2.1` is preview software and depends on experimental Worker Loader support. Unit tests cannot establish deployment safety; real workerd/Cloudflare and Container tests remain mandatory.

## Flue runtime and portability boundary

Flue is Gardener's only product Agent runtime. Host code admits every new run with the qualified Flue adapter version and dispatches it to one generated `GardenerFlueAgent`; users cannot select a framework and Agent source cannot grant or change runtime authority.

Gardener still owns a framework-neutral internal lifecycle contract—`start`, `submit`, `read`, and `cancel`—plus typed request, submission, interruption, usage, and outcome envelopes. This is a maintenance and future-pivot seam, not a multi-harness product feature. There is no automatic fallback and no public generic AI SDK harness.

Flue may call only the Gardener-supplied observation/workspace facade. Persistent GitHub effects are deliberately unrepresentable in the harness tool contract. Model-only runs require no tool binding; Flue's framework-owned tools are deliberately omitted from their provider payload, and a Gardener run requesting tools fails closed until the trusted `GARDENER_HARNESS_TOOLS` facade is provisioned. Immutable Flue requests and accepted submission receipts are persisted in D1 so Workflow retries reattach to the exact request and receipt. Reads are bound back to that receipt. The Flue Cloudflare provider wrapper conservatively checks the complete provider input before dispatch, supplies the immutable maximum output-token count, and propagates an absolute run deadline through an abort signal; the host also durably aborts an overdue Flue instance. Because native Workers AI JSON Mode does not support streaming, the wrapper executes that schema-constrained call non-streaming and converts the complete response into Flue's assistant event protocol before durable projection. Other provider APIs retain their native structured-output shapes. Flue requests below the AI-binding provider's 16-token output floor are rejected before persistence or dispatch. Missing, zero-normalized, or internally inconsistent usage metadata fails closed, and cached input is charged to the immutable input budget. Generated Flue tracing is disabled so repository prompts and model output are not copied into Workers Traces. User Agents remain versioned data and never generate framework classes.

## Effects and optimistic coordination

Planning may read and alter only isolated workspace state. It cannot persistently mutate GitHub. Acting is model-free: Gardener persists an exact typed operation intent, evaluates policy, obtains any exact approval, and requests a grant bound to its canonical hash. Connect re-fetches live state and executes only that payload.

Every external effect requires a stable idempotency key, canonical input hash, persisted intent, explicit retry classification, and persisted receipt. Shared resources use expected SHAs, timestamps/state, operation hashes, and optimistic preconditions. Narrow resource-level coordination is allowed only when an operation is intrinsically exclusive; there is no global Agent mutex.

## Inbox and future channel seam

Inbox and D1 remain authoritative for interruptions, exact effects, blocked/failed runs, draft activation, regressions, cleanup failures, and their decisions. A future channel adapter may observe durable Inbox, run, and output events; credentials and destinations remain structural host configuration and are never visible to the model. A response may affect authority only after authentication and nonce binding, and it must terminate in the existing interruption decision service. Freeform channel text never confers authority.

No channels schema, API, runtime, or UI is implemented. Slack and Teams have no runtime credentials and no blanket-approval path. This is a prose-only integration seam, not a shipped feature. Product traces explain behavior; immutable audit records, hashes, grants, and receipts prove decisions.

## Workspace and authentication boundaries

One Gardener deployment and its D1 database are one workspace; there is no workspace selector. Gardener owns provider-neutral users, external identity links, owner/member memberships, invitations, and session revocation. Exactly one permanent owner is bootstrapped from the pre-existing Connect owner; Gardener has no promotion or ownership-transfer UI.

- Connect issues an instance-audienced, single-use identity assertion. Gardener validates it, records its identifier hash to prevent replay, and exchanges it once for a high-entropy opaque dashboard session. Only the session hash is stored; the assertion is not a persistent browser credential.
- The opaque session is carried in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie on HTTPS and can expire or be revoked.
- The instance authenticates to Connect with a high-entropy Worker secret; Connect stores its hash.
- Connect signs events and identity assertions; Gardener validates issuer, audience, signature, expiry, and active membership. MCP revalidates membership per request and cannot use its principal kind for dashboard-only authority.
- OAuth MCP tokens are separate authoring credentials with explicit scopes and authorized workspace consent.
- Optional Cloudflare Access is an outer transport gate, never a replacement for the opaque Gardener session or any other inner control.
