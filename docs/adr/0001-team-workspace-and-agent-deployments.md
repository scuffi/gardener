# ADR 0001: Team workspace and Agent deployments

- **Status:** Accepted; implemented locally, not yet deployed as Gardener schema v7
- **Date:** 2026-09-15

## Context

Gardener needs team access and repository-scoped Agent enablement without turning portable Agent source into an access-control document. Identity crosses the customer-owned GitHub Gateway/Gardener boundary, while Gardener retains its own revocable authorization state. This ADR is the normative team/assignment foundation; the later Gateway replacement is reflected here and in [Architecture](../architecture.md) and [Foundation status](../foundation-status.md).

## Decision

### Workspace and identity

One Gardener deployment and its one D1 database are one workspace. There is no workspace table, tenant selector, or cross-workspace membership.

Gardener owns provider-neutral internal users and owner/member memberships. External identities are separate links keyed by provider plus immutable provider subject. A provider login is only a mutable display hint; it is never identity proof. Invitations are Gardener-owned, member-only records: the owner enters a GitHub login, the Gateway resolves it to an immutable numeric subject, and Gardener persists that subject before acceptance. Invitations cannot create another owner.

The Gateway completes a random, purpose-bound login handoff over private RPC. Both Workers persist only hashes of browser bearer values. Gardener consumes the handoff once and exchanges it for a high-entropy opaque dashboard session whose token is stored only as a hash. No shared issuer, audience, JWT, JWKS, or instance bearer token remains.

The setup CLI resolves and explicitly confirms one immutable numeric subject before login is enabled, then seeds exactly one permanent owner membership. It cannot be changed or deleted in Gardener. Gardener has no owner-promotion or ownership-transfer UI in V1.

### Human roles and principal kinds

The UI should describe permissions in plain language and make authority-changing actions unmistakable; machine identifiers and exact policy modes remain available for audit. The boundary is exact:

- **Members may propose and narrow:** view the workspace; author drafts; validate and simulate; publish immutable paused revisions; dismiss Inbox items; cancel runs; pause global or repository activity; disable or remove assignments; and narrow assignment or repository policy. “Pause” applies to workspace/repository activity, not to an assignment lifecycle state.
- **Owners may do everything members may do, plus expand authority:** activate revisions; add, widen, enable, or re-enable assignments; resume global or repository activity; approve effects or interruptions; widen or initially configure policy; manage members and member-only invitations; synchronize repositories; and manage the GitHub installation.

Every mutation checks both permission and principal kind. Dashboard-only authority accepts dashboard sessions (and the explicit local-development principal in local development), never an MCP token. MCP authorization re-resolves the active user, external identity, and membership on every request; token claims do not preserve removed or changed membership. MCP remains an authoring surface and cannot reach activation, assignments, policy, approvals, member management, or effects.

### Portable Agents and structural deployment

`gardener.agent/v1` source is repository-independent. It has no `repositories` field, `this` shorthand, repository expansion, or repository provenance. A revision's active pointer is global to the workspace. A repository assignment is a separate, versioned structural deployment record and is disabled by default.

A run is enabled only when both conditions hold: the Agent has an active revision and an exact assignment for the event repository is enabled and not removed. Assignment is the sole enable gate; legacy Agent-level enabled state is not authoritative. “All current repositories” is only an assignment-creation convenience: it atomically materializes the exact active repository IDs observed and confirmed at that moment. It does not create a dynamic selector and does not include future repositories.

### Effective authority and missing policy

Authority is most restrictive. For a persistent effect, Gardener takes the minimum of the workspace policy ceiling, repository policy, revision effect ceiling, and assignment authority ceiling, plus the usual event eligibility, pauses, exact approval, and Gateway/provider live checks. A snapshot freezes admitted authority, while live revalidation can narrow it immediately; later widening never upgrades an in-flight run.

Observation and workspace capabilities are separately intersected with workspace and repository capability policy and the revision's requested capabilities. Workspace-local capabilities are **not** gated by the assignment's persistent-effect authority ceiling. Trigger eligibility plus an enabled exact-repository assignment creates a visible Agent run independently of effect authority. Missing or partial repository policy freezes an all-disabled snapshot, allowing the Flue turn to remain observable while preventing persistent effects; malformed or unhashable policy is rejected as corruption. The runtime writes `repository.policy_unconfigured` with `INSERT OR IGNORE`; a unique repository-scoped audit index intentionally emits this signal once rather than once per event or matching Agent.

### Overlap

Overlapping Agents are allowed. Gardener warns when an assignment add/re-enable/enable or revision activation would put enabled Agents on the same repository with an intersection of both trigger selectors and requested persistent-effect capabilities. Confirmation is bound to a freshly calculated fingerprint and assignment epoch; stale fingerprints must be recomputed and reconfirmed.

The warning is not arbitration. Gardener has no hidden priority, winner, or global Agent lock. Every matching eligible Agent is admitted independently; provider preconditions and exact-effect coordination handle real conflicts visibly.

## Release and cutover

Release is deliberately staged:

1. **Legacy managed-service freeze:** the previously deployed managed Connect remains owner-login-only and must not onboard another customer while the customer-owned Gateway is qualified.
2. **Gardener v7:** pause execution; run `scripts/team-workspace-v7-preflight.mjs`; require zero non-terminal
   runs; dry-run and execute `scripts/team-workspace-v7-cleanup.mjs` strictly before deploy; apply the guarded
   v6-to-v7 migration; deploy Gardener with `--containers-rollout none`; and verify owner bootstrap, opaque sessions,
   invitation creation, and rejection of an uninvited identity.
3. **Gate, then Gateway qualification:** only after Gardener v7 verification may a fresh customer-owned Gateway enable owner/member login. Re-run personal/organization App, multiple-installation, delivery-retry, and exact-effect qualification and keep production globally paused unless separately authorized.

Gardener v7 and the Gateway are implemented locally but have not been deployed. Managed Connect stage 2 is abandoned. This ADR performs no migration or deployment.

This is a clean pre-V1 destructive reset. Existing test Agents and run/runtime evidence are intentionally removed without export so `gardener.agent/v1` has one repository-independent meaning. Repositories, settings, policy rows, and owner state remain. Destructive statements are guarded by schema version 6 and ordered around foreign keys and immutable triggers. Operators must capture reviewed count/hash/key manifests, stop execution, clean external runtime remnants, apply the migration once, and verify retained repositories/settings/policies and fail-closed defaults before unpausing. No production evidence should be represented as surviving this reset.

## Consequences

Agent packages can move between repositories and authoring channels without carrying deployment authority. Team access
is locally revocable, and the customer-owned Gateway remains the identity attester and credential boundary. Repositories connected after
v7 start unconfigured and dark until policy and assignment are explicit. During the destructive v7 migration,
pre-existing active repositories inherit the workspace policy ceiling but remain dark because test Agents are removed
and assignments are required. The cost is additional assignment/policy administration and explicit overlap
confirmation.

The production runtime remains limited to the qualified `github.issue.opened` → model proposal → host-constructed automatic `issue.comment.create` path. Computer-based fix, branch, commit, draft-PR, approval waits, general tool loops, and broader operations remain separate, unqualified work and must not be inferred from this foundation.
