# Security

Gardener is an early public demo, not an SLA-backed service. Please report vulnerabilities privately to the repository maintainers rather than opening a public issue.

## Invariants in this iteration

- GitHub App private keys, OAuth secrets, webhook secrets, and installation tokens stay in the centrally operated Connect Worker.
- Installation tokens are never returned by an API or included in events, prompts, workspace state, or logs.
- Customer instances store their instance token only as a Worker secret; Connect stores its SHA-256 hash.
- Dashboard identity is restricted to the GitHub user bound during the landing/bootstrap flow.
- Every provider mutation is a validated typed operation authorized by a short-lived grant bound to a signed-and-relayed event, repository, and resource.
- Agent output is never authorization.
- Webhook signatures are checked against the unparsed body and delivery IDs are deduplicated.
- Operations are idempotent and bounded; Connect does not expose a raw GitHub proxy.
- Workflows begin paused, and global pause blocks new actions.
- Logs and error responses must not include credentials or upstream authorization headers.

## Required production configuration

Use distinct production secrets, restrict the Connect admin bootstrap endpoint, rotate the Connect signing and GitHub App keys through an announced key-overlap window, and configure the GitHub App with only the permissions documented in `README.md`.

The local development authentication bypass must never be enabled in a public deployment.

## Deferred surface

Computer-based code changes, unrestricted dependency installation, arbitrary network egress, and merge automation are not enabled in the first iteration. Their contract shapes are not a claim that those capabilities are safe or available.
