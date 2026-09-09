# Self-host Gardener Connect

Managed Connect is the effortless default. Organizations that need to own the GitHub App, keys, connector D1 data, availability, and upgrades may deploy `apps/connect` into their own Cloudflare account. This is an advanced operating mode.

Connect and Gardener remain separate Workers even under one operator. Never copy GitHub credentials into Gardener, its AI binding, MCP server, or Computer workspaces.

## What the operator owns

- one Connect Worker and D1 database;
- one reusable GitHub App for all of that Connect deployment's Gardener instances;
- App private key, client secret, and webhook secret;
- a distinct RSA signing key pair for identity/event/grant JWTs;
- optional independent Access credential-encryption key;
- public callbacks/webhooks, monitoring, migrations, revocation, and rotation;
- verification of every enabled GitHub permission, event, API endpoint, and precondition.

Do not create one App per repository or Agent.

## Prerequisites

- Node.js 22+ and pnpm 11.25.0;
- a Cloudflare account authenticated with Wrangler;
- permission to create/manage a GitHub App;
- a public HTTPS Connect origin. GitHub callbacks/webhooks cannot pass through interactive Access login.

```bash
pnpm install
pnpm exec wrangler whoami
```

## Configure Connect

Copy/change `apps/connect/wrangler.jsonc` for the deployment:

- Worker `name`;
- `CONNECT_ISSUER` and `GITHUB_OAUTH_CALLBACK_URL`;
- `DEPLOY_REPOSITORY_URL` for the public Gardener source;
- D1 `database_id`;
- non-secret App ID/client ID/slug values.

```bash
cd apps/connect
pnpm exec wrangler d1 create gardener-connect
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler deploy
```

A first deployment may return unhealthy until secrets are installed.

## Create and review the GitHub App

The target event surface includes issue, pull request, issue/PR comment, PR review/review-comment, discussion/comment, check run/suite, push, release, and installation lifecycle events. The operation catalog may require metadata, contents, issues, pull requests, discussions, checks/statuses, releases, and administration/protection reads. Team eligibility additionally requires organization Members read.

Do not copy this list blindly into production. Review current GitHub documentation and the implemented Connect endpoint for each enabled family. Start with only verified permissions. Existing installations require owner approval when permissions expand, and execution must remain disabled until reauthorization is observed.

The manifest helper is intended to create the App from the repository root:

```bash
node scripts/create-github-app.mjs https://connect.example.com
```

The helper stores returned material with owner-only permissions under `~/.config/gardener/`. It must never be committed. The helper itself still requires Agent-native permission/event review before release.

## Configure keys and secrets

Create a Connect JWT pair distinct from the App key:

```bash
mkdir -p ~/.config/gardener/connect
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out ~/.config/gardener/connect/jwt-private.pem
openssl pkey -in ~/.config/gardener/connect/jwt-private.pem -pubout \
  -out ~/.config/gardener/connect/jwt-public.pem
openssl rand -hex 32
# Optional independent Access encryption key:
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Set non-secret variables in Wrangler configuration and upload secrets interactively:

- `ADMIN_BOOTSTRAP_SECRET`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `CONNECT_JWT_PRIVATE_KEY`
- `CONNECT_JWT_PUBLIC_KEY`
- optional `ACCESS_CREDENTIAL_ENCRYPTION_KEY`

```bash
cd apps/connect
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put CONNECT_JWT_PRIVATE_KEY
pnpm exec wrangler secret put CONNECT_JWT_PUBLIC_KEY
pnpm exec wrangler secret put ADMIN_BOOTSTRAP_SECRET
pnpm exec wrangler deploy
```

Never pass secret values on command lines, put them in URLs/configuration, or send them to support.

## Verify

```bash
curl -f https://connect.example.com/health
curl -f https://connect.example.com/.well-known/jwks.json
```

Verify configured health and the expected key ID. Complete the browser landing flow to create an inert Gardener instance token.

Point both Gardener Connect variables at the origin and install the generated instance token as a Gardener Worker secret:

```json
{
  "vars": {
    "CONNECT_URL": "https://connect.example.com",
    "CONNECT_ISSUER": "https://connect.example.com"
  }
}
```

Gardener discovers JWKS unless an operator explicitly pins `CONNECT_PUBLIC_KEY`.

## Hardening and operations

- Rate-limit public bootstrap without blocking GitHub callbacks/webhooks.
- Alert on signature, relay, permission, grant, stale-state, and receipt failures.
- Keep Connect/Gardener releases independently deployable but contract-compatible.
- Back up Connect D1 and apply numbered migrations deliberately.
- Rotate App and signing keys through tested overlap/revocation procedures.
- Test repository removal, installation suspension/uninstall, instance revoke, and global pause.
- Confirm unsupported operation kinds fail permanently rather than reaching a generic API client.
- Keep provider payload retention bounded and logs credential-free.
- If Access is offered, use a dedicated independent encryption key and one service token per Gardener instance.

Self-hosting changes who operates Connect. It does not weaken exact-effect hashes, live revalidation, typed endpoints, or credential isolation.
