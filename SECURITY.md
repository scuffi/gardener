# Security

Gardener is an early public demo, not an SLA-backed service. Please report vulnerabilities privately to the repository maintainers rather than opening a public issue.

## Invariants in this iteration

- GitHub App private keys, OAuth secrets, webhook secrets, and installation tokens stay in the centrally operated Connect Worker.
- Installation tokens are never returned by an API or included in events, prompts, workspace state, or logs.
- Customer instances store their instance token only as a Worker secret; Connect stores its SHA-256 hash.
- Dashboard identity is restricted to the GitHub user bound during the landing/bootstrap flow.
- Every provider mutation is a validated typed operation authorized by a short-lived grant bound to a signed-and-relayed event, repository, resource, and canonical hash of the exact approved operation payload.
- Agent output is never authorization.
- Webhook signatures are checked against the unparsed body and delivery IDs are deduplicated.
- Operation receipts, execution leases, and App-owned stable markers bind retries. Gardener-created branches and commit targets are confined to the `gardener/` namespace; commits enforce path and size limits, ref updates never force push, and Connect does not expose a raw GitHub proxy.
- Pull-request review, update, and merge operations require the event-bound state, draft status, head SHA, base ref, and base SHA. Merge additionally requires an open non-draft pull request, a protected base branch, app-identity-bound declared checks, an enabled merge method, and GitHub's own protection enforcement.
- The Gardener GitHub App must never be configured as a branch-protection or repository-ruleset bypass actor. Connect deliberately relies on GitHub's merge endpoint to enforce required reviews, code-owner reviews, conversation resolution, up-to-date branches, and rulesets that cannot be reproduced safely from a partial client-side view.
- GitHub's direct merge API provides an atomic head-SHA precondition but no atomic base-ref precondition. Connect checks the event-bound base immediately before merge and verifies the target afterward, but an extremely narrow retarget race cannot be prevented by that API. Merge starts disabled; repositories requiring atomic target authorization should keep direct merge disabled and use GitHub's protected merge queue.
- Workflows begin paused, and global or repository pause blocks new actions.
- Logs and error responses must not include credentials or upstream authorization headers.

## Required production configuration

Use distinct production secrets, restrict the Connect admin bootstrap endpoint, rotate the Connect signing and GitHub App keys through an announced key-overlap window, configure the GitHub App with only the permissions documented in `README.md`, and verify the App is absent from every branch-protection and ruleset bypass list.

The local development authentication bypass must never be enabled in a public deployment.

## Deferred surface

Computer-based model-driven code generation, unrestricted dependency installation, arbitrary network egress, and the workflows that propose code or pull-request operations remain deferred. Typed execution support does not enable those actions: every code and pull-request policy starts off and must be explicitly changed by the instance owner.
