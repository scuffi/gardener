# Security

## Supported security model

Gardener V1 is a customer-deployed, single-workspace system. One Gardener Worker/D1 and one dedicated
GitHub Gateway Worker/D1/GitHub App are installed in the customer's Cloudflare and GitHub accounts.
The deployment is the tenant boundary; neither database contains workspace/tenant discriminator
columns.

Report vulnerabilities privately to the repository maintainers. Do not include live credentials,
private repository content, webhook bodies, model prompts, or customer data in a public issue.

## Trust boundaries

### GitHub Gateway

The Gateway is the only component trusted with GitHub App/OAuth/webhook credentials. It may mint App
JWTs and short-lived installation tokens in memory. Those values are never persisted or returned.
It exposes only callback, webhook, health, and authenticated sanitized operator HTTP routes.
Provider operations are available only through the named `GitHubGatewayEntrypoint` Service Binding.

The Gateway does not accept arbitrary URLs, raw token requests, arbitrary REST calls, policy claims,
or Agent instructions. It accepts strict typed operations and validates delivered event,
repository/installation, resource, precondition, operation-ID, and canonical-hash bindings before
requesting an installation token.

### Gardener

Gardener is authoritative for users, memberships, invitations, roles, sessions, Agents, assignments,
policy, approvals, Inbox, runs, effects, and audit history. It never receives a GitHub credential.
D1 is authoritative; Workflows and Flue coordinate execution but are not competing product ledgers.

The model, Agent source, MCP clients, and Computer workspaces are untrusted proposers. Only trusted
host code can construct a persistent operation. Live state may narrow a frozen run; later widening
never upgrades it.

### Browser identity

GitHub OAuth is identity proof only. Its temporary token is used for `/user` and discarded.
Repository authority comes only from GitHub App installations. The OAuth state is a random one-use
handoff stored only as a SHA-256 hash. Gardener also stores only the handoff hash, consumes it once,
and creates an opaque local session.

The permanent owner is seeded from an explicitly confirmed immutable numeric GitHub ID before OAuth
credentials are enabled. There is no first-user-wins adoption. Invitations are resolved to numeric
subjects before storage; usernames are mutable display snapshots.

Session tokens are random and stored only as SHA-256 hashes. Public cookies are
`__Host-gardener_session`, `Secure`, `HttpOnly`, path `/`, and `SameSite=Lax`; local HTTP uses
`gardener_session`. Sessions have a 30-minute sliding idle limit and eight-hour absolute limit.
State-changing dashboard routes require same-origin requests. MCP principals cannot substitute for
dashboard sessions and are re-resolved against current owner membership on every invocation.

## Installation security

A current owner initiates installation. Gardener and Gateway bind the request to that owner's internal
user ID and immutable GitHub subject. GitHub's callback proves only that an installation belonging to
the dedicated App exists; it marks the request ready. The same initiating owner must perform a
same-origin finalization. Organization account IDs are never treated as human user IDs.

Multiple personal and organization installations are supported. Repository synchronization is
fenced per installation. Deleted or suspended installations narrow live authority immediately.
Newly discovered repositories do not receive assignments or configured policy implicitly.

## Webhook security and recovery

Webhook bodies are bounded and verified against `X-Hub-Signature-256` before parsing. The Gateway
hash-binds the GitHub delivery ID, event name, and exact body. Deliverable events are normalized into
strict trusted facts. Unknown or deliberately unsupported events are recorded as terminal ignored
deliveries rather than silently disappearing.

The Gateway durably persists before returning HTTP `202`, then schedules one direct Gardener RPC
attempt in `waitUntil`. Delivery claims use a lease and random attempt token. Old completions cannot
overwrite a newer retry. Failed/stale deliveries are visible only through the sanitized operator
route and require explicit retry; V1 has no Queue or autonomous retry scheduler.

The operator token is independent of provider execution, stored locally with mode `0600`, accepted
only on `/ops/doctor` and `/ops/deliveries/:id/retry`, and compared without early exit. Rotate it if
exposed.

## Exact effects

The Actions-native V1 path supports all 29 declared GitHub operation kinds automatically. GitHub
Actions owns the trigger, checkout, token permissions, and provider calls. Gardener owns the exact
ordered plan, operation identity, capture binding, and resumable receipts. The model-facing planning
job has a read-only token; the checkout-free apply job inherits only the fixed read union and the
write scopes implied by the task's declared effects. Human approval is intentionally not part of
this release, so merge, release, check-rerun, and other destructive declarations must be treated as
automatic authority.

`repository.exec` runs as the GitHub-hosted runner user. A hostile process can discover and write the
step's runner-command files even though their paths and variables are removed from the model shell,
and a process that creates a new session can outlive process-group cleanup. This can corrupt bridge
step outputs and deny application. It cannot authorize a different provider effect: the Worker
independently re-derives the exact plan and artifact digest before apply, and mismatches fail closed.
Use of `repository.exec` also has unrestricted network egress and is not suitable for sensitive
private source in V1.

The legacy Gateway path still declares all 29 schemas but its qualified automatic runtime remains
narrower. Capability discovery there marks exactly 12 verified executors available and 17
unavailable; unsupported kinds fail before credentials or GitHub I/O.

Operation receipts are keyed by stable operation ID and bind canonical operation hash, exact JSON,
run, delivered event, repository, installation, and resource. Execution and delivery use fenced
leases. Terminal receipts are hash-bound and verified on replay. Ambiguous comments are reconciled
using the exact App-authored marker included in the canonical body:

```html
<!-- gardener-operation:op_abcd1234 -->
```

Provider APIs remain at-least-once at the transport boundary; reconciliation plus stable IDs prevents
duplicate qualified effects.

## Secret handling

Gateway secrets:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `GATEWAY_OPERATOR_TOKEN`
- `OPERATION_MARKER_KEY`

Do not place them in Gardener bindings, argv, URLs, generated config, source files, telemetry, or
logs. `gardener setup` sends secrets through Wrangler stdin. Temporary manifest credentials
are stored only in `~/.config/gardener/<workspace>/setup-recovery.json` with mode `0600`, retained on
partial failure, and deleted only after health/doctor verification.

Cloudflare Access may protect Gardener as defense in depth. It is not the product identity or
provider-operation protocol. Service Bindings—not Access service tokens—protect Worker-to-Worker RPC.

## Deployment and incident rules

- Review printed resources and commands before setup.
- Never run production deployment, migration, App permission expansion, or redelivery without owner
  approval.
- Use `--containers-rollout none` whenever Computer is unchanged.
- Pause and drain before changing a hash-bound runtime/adapter version.
- End qualification with `global_paused=true`.
- Treat unexpected repository/installation, event-integrity, operation-ID, receipt-integrity, or
  attempt-token mismatches as security incidents; preserve both D1 databases and audit records.
- Revoke/rotate the GitHub App key, OAuth secret, webhook secret, operator token, and marker key from
  the owning accounts as appropriate. Do not export installation tokens—they are intentionally not
  retained.

See [Architecture](docs/architecture.md) and the [Gateway runbook](docs/github-gateway.md).
