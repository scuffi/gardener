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

The active Issue Gardener workflow handles issue events and proposes bounded label and comment changes. The policy and Connect layers support the complete typed maintainer surface: issue actions, branch creation, bounded commits, pull-request creation and updates (including close/reopen and draft state), grouped reviews, and protected merge. Code and pull-request policies start disabled; Computer-based code generation and additional workflows remain deferred.

## Trust model

- GitHub authenticates to Connect with the webhook HMAC secret.
- Connect signs normalized events and user identity tokens asymmetrically; Gardener verifies them against the configured public key/JWKS.
- Cloudflare Access is an optional outer transport gate, not Gardener's primary authentication. When enabled, Connect presents an instance-specific Access service token before Gardener independently verifies the signed event JWT. Managed Connect stores that optional credential encrypted and binds its ciphertext to the instance ID.
- The Connect landing flow authenticates the deploying GitHub user before issuing a Gardener instance token; later dashboard identity tokens are restricted to that owner.
- A Gardener instance authenticates to Connect with its high-entropy instance token. Connect stores only its SHA-256 hash.
- The instance token may request a short-lived grant; it is not accepted by an operation endpoint as write authority.
- Grants bind an instance, signed-and-relayed event, installation, repository, resource, operation scopes, and expiration.
- Connect binds grants to canonical hashes of exact approved operations, re-fetches relevant GitHub state when executing a mutation, and records operation IDs for retry safety.
- Agent output is untrusted data. Gardener validates it into typed proposals, evaluates the immutable run policy snapshot, and either discards, queues for approval, or submits the exact typed payload with a hash-bound grant.
- Pull-request operations bind the expected state, draft status, head revision, and base revision from the delivered event. The Gardener GitHub App must not appear on branch-protection or ruleset bypass lists; GitHub remains responsible for enforcing review, conversation, freshness, and ruleset requirements at merge time.

## Deliberately small v1

The first release uses D1 and one Queue. It does not add Durable Objects, R2, AI Gateway, a plugin system, or a generic provider framework until contention, artifact size, or additional providers justify them. The `AgentRuntime` and typed connector contracts are the intentional seams.

Workflows start paused. Every typed operation has an independent Disabled / Approval / Automatic mode, with code and pull-request operations disabled by default. Global and repository pause controls block admission of new execution without deleting state.
