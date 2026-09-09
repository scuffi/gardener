# Gardener Agent-native architecture

## Status

This document describes the target architecture and identifies what exists in the current foundation. It is not a claim that end-to-end Agent execution is ready. The current `AgentRunWorkflow` fails closed before model or tool execution because trusted observation, tool, and exact-effect integrations are incomplete.

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

`apps/gardener` owns owner sessions, repository selection, Agent packages, mutable drafts, immutable revisions, activation and enablement state, policy, Inbox decisions, events, runs, tasks, steps, interruptions, temporary grants, effect intents, receipts, leases, artifacts, and audit history.

Gardener has an AI binding but no GitHub credential. Standard deployment needs no model-provider secret. An instance setting selects a Gardener-owned harness adapter; the immutable run snapshot pins the actual harness ID and adapter version.

## Authority layers

These layers remain separate and fail closed:

1. **Admission:** global/repository pause and an enabled Agent with an active immutable revision.
2. **Event eligibility:** a `RepositoryEventV2` trigger, immutable repository ID, and trusted actor/resource facts.
3. **Revision capability ceiling:** capabilities explicitly requested by the compiled Agent revision.
4. **Instance policy:** observations and workspace/effect modes (`disabled`, `approval`, `automatic`).
5. **Authoring authorization:** owner session or OAuth MCP scopes; authoring never implies runtime authority.
6. **One-run grants:** narrowly scoped, expiring approvals for grantable observation/workspace needs.
7. **Typed interruption:** authenticated, responder-bound, nonce-bound human input or decision.
8. **Exact-effect decision:** one canonical operation payload and hash, never a blanket plan approval.
9. **Connect execution:** event/grant/repository/resource binding, live-state preconditions, provider permissions, idempotency, and receipt.

Repository content, comments, model output, Agent prose, channel messages, and eval scores may influence planning but never authorize an effect.

## Authoring and immutable data

`AgentSourceV1` preserves the exact bytes of `AGENT.md` and supporting files as canonical base64. The parser separately produces strict semantics. Compilation resolves `this` and explicit selectors to immutable GitHub repository IDs and records source, semantic, referenced-file, compiler, catalog, and runtime identities.

Drafts remain mutable and paused. Publication creates an immutable paused revision. Activation changes the active revision pointer. Enablement is a separate owner action. A run binds `CompiledAgentRevisionV1`, effective capabilities, policy, harness, budgets, and all component versions in `AgentRunSnapshotV1`.

Dashboard, direct Markdown, Git-native publication, CLI clients, and OAuth MCP are intended to call the same canonical services. MCP currently exposes only read, validate, explain, diff, simulation, paused-draft, and redacted-trace tools.

## Durable run model

The target runtime has one deployed generic `AgentRunWorkflow`; user Agent creation is a data operation and never creates a Worker class or Wrangler deployment.

D1 is authoritative for:

- Agents, drafts, revisions, activation, and enablement;
- normalized events and admission decisions;
- runs, parallel tasks, durable steps, usage, and errors;
- interruptions and one-run capability grants;
- effect intents, canonical operation hashes, approvals, and receipts;
- Inbox items, evals, artifacts, and workspace cleanup leases.

Cloudflare Workflows owns durable continuation, deterministic step retry, sleeps, waits, cancellation, and replay. Large snapshots, patches, transcripts, logs, and tool output are referenced from host-controlled R2 instead of being embedded in Workflow state. Promise-based parallel groups must be deterministic; authoritative orchestration must not use `Promise.race()` or `Promise.any()` because losing work continues and replay selection can diverge.

The current entrypoint only verifies the run/snapshot binding and records a terminal integration error. The durable model/tool loop, interruption waits, child joins, exact effects, and cleanup sequencing remain release blockers.

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

## Replaceable model harnesses

Gardener owns one framework-neutral lifecycle and conformance suite. Static generic adapters exist for:

- **Flue** — default instance selection;
- **Think** — supported preview adapter;
- **Cloudflare Agents SDK + AI binding** — minimal direct adapter.

There is no public generic AI SDK harness. Each adapter may call only the Gardener-supplied observation/workspace facade. Persistent GitHub effects are deliberately unrepresentable in the harness tool contract. User Agents never generate framework classes.

The adapters and static classes exist, but the trusted `GARDENER_HARNESS_TOOLS` facade, Flue build transform/export, Durable Object locator wiring, and run orchestration are not yet fully integrated.

## Effects and optimistic coordination

Planning may read and alter only isolated workspace state. It cannot persistently mutate GitHub. Acting is model-free: Gardener persists an exact typed operation intent, evaluates policy, obtains any exact approval, and requests a grant bound to its canonical hash. Connect re-fetches live state and executes only that payload.

Every external effect requires a stable idempotency key, canonical input hash, persisted intent, explicit retry classification, and persisted receipt. Shared resources use expected SHAs, timestamps/state, operation hashes, and optimistic preconditions. Narrow resource-level coordination is allowed only when an operation is intrinsically exclusive; there is no global Agent mutex.

## Inbox and channels

Inbox is the canonical decision surface for interruptions, exact effects, blocked/failed runs, draft activation, regressions, and cleanup failures. Slack, email, GitHub, and other channels may notify or carry authenticated nonce-bound responses later. Freeform channel text never confers authority. Product traces explain behavior; immutable audit records, hashes, grants, and receipts prove decisions.

## Authentication boundaries

- The Gardener owner session is established from a Connect-issued, instance-audienced GitHub identity token and stored in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
- The instance authenticates to Connect with a high-entropy Worker secret; Connect stores its hash.
- Connect signs events and identities; Gardener validates issuer, audience, signature, and expiry.
- OAuth MCP tokens are separate authoring credentials with explicit scopes and owner consent.
- Optional Cloudflare Access is an outer transport gate, never a replacement for any inner control.
