# First iteration scope

This repository intentionally starts with one complete, inspectable path rather than pretending to implement the whole PRD at once.

## Included

- Central Connect Worker and customer-deployed Gardener Worker in one repository
- Instance bootstrap/claim and asymmetric Connect signatures
- GitHub login, App installation association, repository discovery, webhook verification, and delivery deduplication
- Normalized issue events
- Immutable, paused-by-default Issue Gardener workflow
- Workers AI analysis producing typed proposals
- Independent Disabled / Approval / Automatic modes for issue labels and comments
- Short-lived repository/resource/operation-scoped grants
- Typed GitHub label, comment, close, and reopen operations
- Current-state checks and operation idempotency in Connect
- Persistent runs, proposals, approvals, costs/usage when reported, and audit entries
- Global pause and basic health diagnostics
- Deploy to Cloudflare configuration for the customer Worker
- Guided first-run setup that confirms ownership, opens the GitHub repository picker, synchronizes access, and activates a safe policy preset in one flow

## Deferred until this path is proven

- `@cloudflare/computer` workspaces and code editing
- Branch, commit, pull request, review, and merge execution
- Scheduled Repository Steward runs
- Durable Objects and R2
- Additional model/runtime adapters
- Customer-owned connectors and GitLab
- Roles, teams, marketplace packs, and upgrade automation

The shared contracts include enough shape to add these without granting authority to untrusted agent output. Deferred operations must not appear enabled in the UI or documentation.

## Exit criteria

A tester can deploy Gardener, finish the guided configuration flow, connect multiple selected repositories, activate the recommended profile, receive an issue webhook, inspect a durable run and proposals, approve a comment, allow labels automatically, and stop all new execution with global pause. GitHub credentials must remain exclusive to Connect throughout.
