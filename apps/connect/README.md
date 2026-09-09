# Gardener Connect

Gardener Connect is the independently deployed GitHub credential boundary. The Gardener team operates it by default; self-hosting is an advanced option. It verifies GitHub, signs strict events and identities, supplies bounded observations/snapshots, grants exact operations, and executes only verified typed GitHub calls. Installation tokens and App credentials never enter Gardener.

## Current status

`RepositoryEventV2` normalization and the full `OperationV2` contract are being integrated. Existing executors cover a subset of the catalog. Any catalog kind without a reviewed GitHub endpoint, permission, live precondition, and idempotency strategy must return a persisted permanent `unsupported_operation` receipt. Do not describe the complete catalog as live until Connect tests and App permission reauthorization pass.

## Setup

1. Create one reusable GitHub App for this Connect deployment. Configure OAuth callbacks `/v1/landing/callback` and `/v1/auth/github/callback`, setup callback `/v1/installations/callback`, and webhook `/github/webhook`.
2. Configure only the permissions/events verified for the operation/event families you are enabling. The target catalog requires metadata plus appropriate contents, issues, pull requests, discussions, checks/statuses, releases, and protected-branch observation. Team eligibility additionally requires organization Members read. Permission expansion on an existing App requires installation-owner approval/reauthorization; do not assume it is seamless.
3. Create D1, set its ID in `wrangler.jsonc`, and copy `.dev.vars.example` to untracked `.dev.vars`.
4. Provide separate RSA key pairs for Connect JWT signing and GitHub App authentication. Optional Access credential storage also requires an independent 32-byte `ACCESS_CREDENTIAL_ENCRYPTION_KEY`.
5. Apply migrations and deploy:

```bash
pnpm db:migrate
pnpm deploy
```

## Public contract

- `GET /health` and `GET /.well-known/jwks.json`.
- Landing/bootstrap endpoints authenticate the deploying GitHub user, create an inert instance, and return a one-time `gdn_<instance-id>.<random>` token. D1 stores only its SHA-256 hash.
- Claim binds the exact public HTTPS `*.workers.dev` Gardener callback (loopback is accepted only for local development) and may register/clear an encrypted optional Cloudflare Access service-token pair. Managed Connect does not relay to arbitrary custom hosts.
- Dashboard OAuth returns an instance-audienced identity token. Gardener converts it to its own secure owner session.
- Installation endpoints associate the App installation and return selected repository metadata to the authenticated instance.
- `POST /github/webhook` verifies HMAC over raw bytes, deduplicates delivery IDs, strictly normalizes supported events to `RepositoryEventV2`, signs them, and relays an Authorization-only bearer request to the claimed callback with redirects disabled. The Worker uses `global_fetch_strictly_public`; missing immutable IDs/facts and unknown actions fail closed.
- Observation/snapshot interfaces must return Connect-attested bounded facts and exact-SHA repository input without exposing credentials. This part remains an integration blocker.
- `POST /v1/grants` creates a short-lived grant for one instance/run/event/repository/resource and canonical hashes of exact typed operations.
- `POST /v1/operations` accepts strict operation payloads only when their canonical hash is in the grant, re-fetches relevant state, mints the least-privilege one-repository installation token internally, executes or returns a typed conflict/permanent/transient result, and persists `OperationReceiptV2`.

Only the GitHub owner bound during bootstrap may obtain a dashboard identity for the instance. Identity/event JWTs are Gardener-instance-audienced; grants are Connect-audienced. An instance token alone cannot call the operation executor.

## Target event families

`RepositoryEventV2` covers issues, pull requests, issue/PR comments, PR reviews/review comments, discussions/comments, check runs/suites, pushes, and releases. Gardener manual/scheduled events are created by Gardener rather than accepted from the GitHub webhook endpoint.

Connect rejects payloads that cannot attest the required immutable resource state. For example, a GitHub comment payload that does not carry trustworthy PR head/base facts must be enriched through an authenticated read or rejected, never guessed.

## Target typed operation catalog

- Issue labels/comments/state/assignees.
- PR comments, reviews, reviewer requests/removals, updates, draft opening, and protected merge.
- `gardener/` branch creation and bounded commit creation.
- Discussion comments/answers/state.
- Check rerun.
- Release draft create/update/publish/delete.

See [`../../docs/agent-authoring.md`](../../docs/agent-authoring.md) for exact operation names. The contract is broader than the currently verified executor set.

## Security requirements

- No raw provider proxy or installation-token response.
- Strict schemas and endpoint/body allowlists.
- Event/repository/resource/hash/expiry binding.
- Live state and permission revalidation immediately before mutation.
- Stable operation IDs, canonical hashes, durable receipts, and bounded retries.
- No force push, credentialed snapshot, or branch/ruleset bypass.
- Global, instance, installation, and repository revocation.
- Sanitized logs and bounded provider-payload retention.
- Dedicated Access Service Auth credentials are AES-256-GCM encrypted, instance-bound, never returned, and decrypted only for outbound relay.

Optional Cloudflare Access details are in [`../../docs/cloudflare-access.md`](../../docs/cloudflare-access.md). Self-hosting guidance is in [`../../docs/self-hosted-connect.md`](../../docs/self-hosted-connect.md).
