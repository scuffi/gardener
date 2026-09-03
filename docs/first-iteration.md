# First iteration scope

This repository intentionally starts with one complete, inspectable path rather than pretending to implement the whole PRD at once.

## Included

- Central Connect Worker and customer-deployed Gardener Worker in one repository
- Instance bootstrap/claim and asymmetric Connect signatures
- GitHub login, App installation association, repository discovery, webhook verification, and delivery deduplication
- Normalized issue and pull-request events
- Immutable, paused-by-default Issue Gardener workflow
- Workers AI analysis producing typed proposals
- Independent Disabled / Approval / Automatic modes for every typed maintainer operation
- Short-lived repository/resource/operation-scoped grants
- Typed issue, branch, bounded commit, pull-request lifecycle, review, and protected-merge operations
- Current-state and exact-revision checks, no force pushes, branch-protection enforcement, and operation idempotency in Connect
- Persistent runs, proposals, approvals, costs/usage when reported, and audit entries
- Global and per-repository admission controls plus basic health diagnostics
- Deploy to Cloudflare configuration for the customer Worker
- Guided first-run setup that confirms ownership, opens the GitHub repository picker, synchronizes access, and activates a safe policy preset in one flow

## Deferred until this path is proven

- `@cloudflare/computer` workspaces and model-driven code editing
- PR Gardener and Maintenance Fixer workflows that produce the new maintainer operations
- Scheduled Repository Steward runs
- Durable Objects and R2
- Additional model/runtime adapters
- Customer-owned connectors and GitLab
- Roles, teams, marketplace packs, and upgrade automation

The maintainer operation contracts and policies are available now, but all code and pull-request policies start disabled. Deferred workflows must not be presented as active capabilities.

## Exit criteria

A tester can deploy Gardener, finish the guided configuration flow, connect multiple selected repositories, activate the recommended profile, receive an issue webhook, inspect a durable run and proposals, approve a comment, allow labels automatically, and stop all new execution globally or for one repository. GitHub credentials must remain exclusive to Connect throughout.
