# Gardener Connect

Central Cloudflare Worker for Gardener's managed GitHub boundary. It keeps GitHub App credentials and installation tokens out of customer Workers and exposes only signed identities/events, scoped run grants, and typed maintainer operations.

## Setup

1. Create one managed GitHub App. Use its client ID/secret for user authorization, add OAuth callback URLs for `/v1/landing/callback` and `/v1/auth/github/callback`, set the GitHub App setup URL to `/v1/installations/callback`, and webhook URL to `/github/webhook`.
2. Give the GitHub App **metadata, administration, checks, and commit statuses: read** plus **contents, issues, and pull requests: write** permissions. Subscribe to issue and pull-request events; installation lifecycle events are implicit.
3. Create D1, replace the ID in `wrangler.jsonc`, copy `.dev.vars.example` to `.dev.vars`, and provide separate RSA key pairs for Connect JWT signing and GitHub App authentication.
4. Run `pnpm db:migrate:local && pnpm dev` (or `pnpm db:migrate && pnpm deploy`).

## Contract

- `GET /health`, `GET /.well-known/jwks.json`
- `GET /v1/landing/start`, `GET /v1/landing/callback`, `POST /v1/bootstrap`: the managed landing page first binds the deploying GitHub user, then creates an inert instance and returns its one-time `gdn_<instance-id>.<random>` token plus the Deploy to Cloudflare URL. D1 receives only SHA-256. The admin-protected variant allows a chosen instance ID for operations/testing.
- `POST /v1/instances/claim` (instance bearer): binds the exact HTTPS webhook callback.
- `POST /v1/auth/github/start`, `GET /v1/auth/github/callback`: OAuth and an eight-hour instance-audienced dashboard identity JWT, stored only in the customer's browser tab.
- `POST /v1/installations/setup` (identity JWT), `GET /v1/installations/callback`, `GET /v1/repositories` (instance bearer): verified installation assignment and repository discovery.
- `POST /github/webhook`: verifies HMAC over raw bytes, deduplicates delivery IDs, normalizes issue and pull-request events, signs them, and relays `{ "token": "..." }` to the claimed callback.
- `POST /v1/grants` (instance bearer): creates a five-minute grant for one run, delivered event resource, repository, and canonical hashes of the exact approved operation payloads. Connect refuses grants that do not reference a matching event it signed and relayed to that instance.
- `POST /v1/operations` (grant bearer): executes only strict `v1` issue, branch, commit, pull-request review, pull-request lifecycle, and protected-merge operations. Connect re-fetches state, mints a least-privilege one-repository installation token internally, refuses force pushes, and records stable operation receipts.

Only the GitHub user bound during bootstrap may receive dashboard identity tokens for that instance. Identity and event JWTs are audience-bound to the instance. Grants are audience-bound to Connect. Installation tokens are never returned from an endpoint or persisted.
