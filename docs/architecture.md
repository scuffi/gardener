# Gardener architecture

Gardener is one repository with two independently deployed Cloudflare Workers.

```text
GitHub ──webhooks──▶ Connect ──signed event──▶ customer Gardener
  ▲                    ▲                            │
  │                    └── scoped grant + typed op ─┘
  └──────── installation token held only here
```

## Deployment boundaries

### Connect (`apps/connect`)

Connect is the small, centrally operated control plane. It owns the shared GitHub App, verifies GitHub webhooks, associates installations with Gardener instances, issues short-lived identity and run-grant JWTs, and translates validated typed operations into GitHub API calls.

Connect is implemented in this repository but is **not** installed into customer accounts. Its GitHub App private key, OAuth secret, webhook secret, and signing key are Worker secrets in the centrally operated deployment.

### Gardener (`apps/gardener`)

Gardener is the customer data plane deployed into the user's Cloudflare account. It owns repository selections, workflows, policy, runs, proposals, approvals, audit records, Workers AI usage, and its dashboard. GitHub credentials never cross into this deployment.

The first iteration handles issue events and can propose or perform bounded label, comment, close, and reopen operations. The contracts include extension points for PR reviews and code changes, but Computer workspaces and merge automation are deliberately deferred until the issue-gardening slice is proven.

## Trust model

- GitHub authenticates to Connect with the webhook HMAC secret.
- Connect signs normalized events and user identity tokens asymmetrically; Gardener verifies them against the configured public key/JWKS.
- The Connect landing flow authenticates the deploying GitHub user before issuing a Gardener instance token; later dashboard identity tokens are restricted to that owner.
- A Gardener instance authenticates to Connect with its high-entropy instance token. Connect stores only its SHA-256 hash.
- The instance token may request a short-lived grant; it is not accepted by an operation endpoint as write authority.
- Grants bind an instance, signed-and-relayed event, installation, repository, resource, operation scopes, and expiration.
- Connect re-fetches relevant GitHub state when executing a mutation and records operation IDs for idempotency.
- Agent output is untrusted data. Gardener validates it into typed proposals, evaluates the immutable run policy snapshot, and either discards, queues for approval, or submits it with a grant.

## Deliberately small v1

The first release uses D1 and one Queue. It does not add Durable Objects, R2, AI Gateway, a plugin system, or a generic provider framework until contention, artifact size, or additional providers justify them. The `AgentRuntime` and typed connector contracts are the intentional seams.

Workflows start paused. Labels and comments have independent Disabled / Approval / Automatic modes. Global pause blocks new execution without deleting state.
