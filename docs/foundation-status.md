# Agent-native foundation status

## Release state

The team/workspace and repository-assignment foundation, including Gardener schema v7, is implemented locally but Gardener v7 is not deployed yet. Connect stage 1 is deployed and remains owner-login-only; Connect stage 2 member login is not deployed. The existing production runtime remains the experimental bounded slice for explicitly labeled issue-opened events and automatic `issue.comment.create` policy. It is not a general repository-stewardship release: every unsupported event, non-automatic effect, tool, workspace, and orchestration path remains fail closed.

## Implemented foundations

- Strict versioned `AgentSourceV1`, `AgentRevisionV1`, `CompiledAgentRevisionV1`, and `AgentRunSnapshotV1` contracts.
- Exact-byte, repository-independent `AGENT.md` packages with strict YAML/Markdown parsing, semantic diffs, capabilities, budgets, eligibility, supporting-file identities, and hashes.
- `RepositoryEventV2` and a broad strict typed operation catalog.
- Agent-native D1 tables/persistence for provider-neutral users, external identities, owner/member memberships, invitations, hashed opaque sessions, drafts, revisions, global activation, structural assignments and history, workspace/repository policy, events, admissions, runs, tasks, steps, artifacts, interruptions, grants, effects, Inbox, evals, and workspace leases.
- Agent management endpoints and dashboard flows for validation, capability review, simulation, drafts, paused publication, global activation, exact-repository assignment, repository policy, Inbox, and History.
- `@cloudflare/computer` workspace adapter with exact-SHA hydration, local-only Git, network-denied Worker execution, lazy Container, bounded outputs, sync blocking, frozen artifacts, ambiguous-replay handling, and cleanup leases.
- Flue-only product runtime behind a Gardener-owned, framework-neutral harness contract, with immutable D1 request/submission storage, pre-dispatch model bounds, non-streaming native Workers AI JSON Mode adapted into Flue's durable assistant stream, absolute runtime cancellation, authoritative receipt reads, content-free tracing, and host-side request/outcome/schema/usage validation retained as the portability seam.
- OAuth-protected stateless MCP contract for read/validate/simulate/paused-draft/redacted-trace authoring.
- One generic `AgentRunWorkflow` with a bounded model-only issue-comment path, immutable snapshot validation, deterministic admission/effect identities, live authority revalidation, Connect V2 execution, and strict receipt persistence.
- Retained production qualification evidence at [`scuffi/flue#18`](https://github.com/scuffi/flue/issues/18): `flue@2.0.1` completed with nonzero consistent usage, exactly one hash-bound comment effect and successful Connect receipt, and an exact webhook redelivery produced no second event, run, effect, operation attempt, or comment. Gardener was returned to global pause. Subsequent reviewed adapter behavior is assigned `flue@2.0.2` / `bounded-issue-comment-v3`; the historical run is not relabeled.
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

- Connect hooks persist verified V2 events and use a narrow admission lease. An eligible revision receives an independent immutable run only when it is the workspace-global active revision, an enabled non-removed structural assignment exists for the event's exact repository, repository policy is complete and valid, and the workspace/repository are unpaused. Assignment is the sole enable gate; Agent-level enabled state is not authoritative.
- The live runtime accepts only `github.issue.opened` and only an effective automatic `issue.comment.create` capability. The model proposes comment text; trusted host code supplies repository identity, issue preconditions, operation ID, and hash.
- Draft simulation remains validation-only and reports `executed: false`; it does not run the model or effects.
- Approval-mode effects, typed interruption waits, workspace tools, Computer, Container, and delegated child tasks remain unavailable through the runtime.
- Catalog operation kinds without a verified Connect executor must return a permanent typed unsupported result.
- OAuth MCP returns unavailable unless its required storage binding is configured.

## Destructive old-automation reset

The clean pre-V1 schema cutover intentionally has no export path. It removes old test Agent definitions/revisions and run/runtime evidence so Agent V1 has one repository-independent meaning. It retains repositories, settings, the Connect owner state, and existing policy modes; new operation kinds remain disabled. The new local v7 identity model exchanges a one-time Connect assertion for a Gardener-owned opaque session stored only as a hash, with provider-neutral users and one permanent owner/member workspace membership model.

Before production cutover:

1. Complete and review the migration concurrency/immutability tests.
2. Confirm that the owner accepts no export of old automation history.
3. Pause the instance, stop old execution, and require zero non-terminal runs.
4. Confirm deployed Connect stage 1 remains owner-login-only; do not open member login.
5. Capture a sealed mode-0600 manifest while the database is still schema v6:

   ```sh
   node scripts/team-workspace-v7-preflight.mjs \
     --output .secrets/v7-preflight.json --database gardener --cwd apps/gardener
   ```

6. Review cleanup in dry-run mode, then execute it with the manifest's exact hash confirmation:

   ```sh
   node scripts/team-workspace-v7-cleanup.mjs --manifest .secrets/v7-preflight.json
   node scripts/team-workspace-v7-cleanup.mjs --manifest .secrets/v7-preflight.json \
     --execute --confirm DELETE:<manifest-sha256>
   ```

   Cleanup must complete strictly before Gardener v7 deploys. Migration v7 removes the D1 rows that identify
   captured external resources. A captured workspace Durable Object key makes cleanup abort before any destructive
   call; resolve that blocker and repeat preflight rather than proceeding partially.
7. Deploy Gardener v7 with `--containers-rollout none` and apply the Agent-native reset exactly once.
8. Verify retained repositories/settings/policies, owner bootstrap, opaque session exchange, invitations, assignments,
   and fail-closed defaults.
9. Only after that gate may Connect stage 2 member login deploy. Create new Agents as paused drafts and disabled
   assignments; do not synthesize deployments from old data.

Do not apply this reset to production merely to test the foundation.

## Release gate

A release requires all package tests/typechecks/builds, migration and replay tests, independent correctness/security review, keyboard/Axe/zoom/mobile/light/dark browser review, real Cloudflare staging, and exact-effect Connect tests to pass. Connect stage 1 is already deployed owner-only. Gardener v7 must pass this gate before deployment; Connect stage 2 remains blocked until the v7 owner/session/invitation checks pass. Then verify live health, Access behavior, event admission, interruptions, receipts, pause, and cleanup.
