# Agent-native foundation status

## Release state

The hard Agent-native cutover is complete. This branch now includes an experimental end-to-end runtime slice for explicitly labeled issue-opened events and automatic `issue.comment.create` policy. It is not yet a general repository-stewardship release: every unsupported event, non-automatic effect, tool, workspace, and orchestration path remains fail closed.

## Implemented foundations

- Strict versioned `AgentSourceV1`, `AgentRevisionV1`, `CompiledAgentRevisionV1`, and `AgentRunSnapshotV1` contracts.
- Exact-byte `AGENT.md` packages, strict YAML/Markdown parsing, immutable repository-ID compilation, provenance, semantic diffs, capabilities, budgets, eligibility, and hashes.
- `RepositoryEventV2` and a broad strict typed operation catalog.
- Agent-native D1 tables/persistence for drafts, revisions, activation, enablement, events, admissions, runs, tasks, steps, artifacts, interruptions, grants, effects, Inbox, evals, and workspace leases.
- Agent management endpoints and dashboard flows for validation, capability review, repository-context binding, simulation, drafts, paused publication, activation, enablement, Inbox, and History.
- `@cloudflare/computer` workspace adapter with exact-SHA hydration, local-only Git, network-denied Worker execution, lazy Container, bounded outputs, sync blocking, frozen artifacts, ambiguous-replay handling, and cleanup leases.
- Flue-only product runtime behind a Gardener-owned, framework-neutral harness contract, with immutable D1 request/submission storage, pre-dispatch model bounds, absolute runtime cancellation, authoritative receipt reads, and host-side request/outcome/schema/usage validation retained as the portability seam.
- OAuth-protected stateless MCP contract for read/validate/simulate/paused-draft/redacted-trace authoring.
- One generic `AgentRunWorkflow` with a bounded model-only issue-comment path, immutable snapshot validation, deterministic admission/effect identities, live authority revalidation, Connect V2 execution, and strict receipt persistence.
- Converged Agent-native root/app deployment configuration, Authorization-only Connect relay, local migration/dry-run validation, and Agent-native browser smoke coverage for lifecycle separation, event admission, light/dark, keyboard focus, responsive reflow, and serious/critical Axe findings.
- Independent foundation security review and focused re-review of relay authentication, callback SSRF controls, run-state CAS, and fail-closed readiness reporting.

Passing focused tests for an individual foundation are useful but do not establish integrated runtime safety.

## Current blockers

- Generalize the currently single-turn, single-effect runtime into a durable tool loop with deterministic parallel task groups, child joins, interruption waits, complete budget accounting, cancellation, multi-effect sequencing, and cleanup.
- Bind a trusted `GARDENER_HARNESS_TOOLS` facade that revalidates the immutable run snapshot, capabilities, budgets, and tool arguments and exposes no persistent-effect authority.
- Finish Connect V2 trusted observations, exact-SHA snapshot delivery, the supported operation executors, live preconditions, and strict receipts. Verify GitHub webhook actions, API endpoints, App permissions, and owner reauthorization rather than guessing.
- Keep operation policy seeds aligned with the canonical contract and leave unsupported operation kinds fail closed until their Connect executors are verified.
- Configure and test OAuth storage/server metadata on real Cloudflare resources; the local consent/audience/client/owner review and tests do not replace staging.
- Add parallel run/task detail surfaces when the trusted runtime exists; do not fabricate them while execution is disabled.
- Extend the Agent-native smoke with runtime-only cases—parallelism, interruptions, retries, stale responses, and exact receipts—after those trusted paths are implemented.
- Complete broader real Cloudflare staging for Workflows, Worker Loader, the Flue Durable Object, R2, Container, waits, joins, sync recovery, OAuth, and cleanup.

## Bounded and fail-closed behavior today

- Connect hooks persist verified V2 events and use a narrow admission lease. Eligible enabled revisions receive independent immutable runs only when the instance and repository are unpaused.
- The live runtime accepts only `github.issue.opened` and only an effective automatic `issue.comment.create` capability. The model proposes comment text; trusted host code supplies repository identity, issue preconditions, operation ID, and hash.
- Draft simulation remains validation-only and reports `executed: false`; it does not run the model or effects.
- Approval-mode effects, typed interruption waits, workspace tools, Computer, Container, and delegated child tasks remain unavailable through the runtime.
- Catalog operation kinds without a verified Connect executor must return a permanent typed unsupported result.
- OAuth MCP returns unavailable unless its required storage binding is configured.

## Destructive old-automation reset

The schema cutover intentionally has no export path. For an installation with old automation tables, the reset removes old definitions/revisions, events, runs, proposals/results, and audit rows. It retains repository selections, settings/owner authentication state where represented outside those tables, and existing operation-policy modes; new operation kinds remain disabled.

Before production cutover:

1. Complete and review the migration concurrency/immutability tests.
2. Confirm that the owner accepts no export of old automation history.
3. Pause the instance and stop old execution.
4. Deploy compatible Connect/Gardener contracts in the reviewed order.
5. Apply the Agent-native reset exactly once.
6. Verify repositories, settings, owner sign-in, policy modes, and fail-closed defaults.
7. Create new Agents as paused drafts; do not synthesize enabled Agents from old data.

Do not apply this reset to production merely to test the foundation.

## Release gate

A release requires all package tests/typechecks/builds, migration and replay tests, independent correctness/security review, keyboard/Axe/zoom/mobile/light/dark browser review, real Cloudflare staging, and exact-effect Connect tests to pass. Only then should Connect and Gardener be deployed and live health, Access behavior, event admission, interruptions, receipts, pause, and cleanup be verified.
