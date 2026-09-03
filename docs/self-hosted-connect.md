# Self-host Gardener Connect

Gardener uses the hosted Connect service by default. Organizations that need to own their GitHub App, credentials, signing keys, connector data, and availability can deploy the same Connect Worker into their own Cloudflare account.

This is an advanced operating mode, not a requirement for deploying Gardener. Connect and Gardener remain separate Workers even when the same organization owns both, so GitHub credentials never enter the Gardener Worker or Workers AI.

## What you operate

A self-hosted installation owns:

- one Connect Worker and D1 database;
- one reusable GitHub App for all of its Gardener instances;
- the GitHub App private key, client secret, and webhook secret;
- a separate RSA key pair for Connect identity, event, and grant JWTs;
- public callback and webhook availability, upgrades, monitoring, and key rotation.

Do not create a GitHub App per repository or Gardener deployment. One App can be installed on many selected repositories and serve many Gardener instances.

## Prerequisites

- Node.js 22 or newer and pnpm 11.25.0
- a Cloudflare account authenticated with Wrangler
- permission to create a GitHub App
- a public HTTPS Connect URL; GitHub callbacks and webhooks cannot pass through an interactive Cloudflare Access login

Install dependencies and verify Wrangler first:

```bash
pnpm install
pnpm exec wrangler whoami
```

## 1. Prepare Connect

Copy `apps/connect/wrangler.jsonc` for your environment and change:

- `name`
- `CONNECT_ISSUER` to the final public Connect origin
- `GITHUB_OAUTH_CALLBACK_URL` to `<origin>/v1/auth/github/callback`
- `DEPLOY_REPOSITORY_URL` to the public Gardener source customers should deploy
- the D1 `database_id`

Create D1 and copy the returned ID into the configuration:

```bash
cd apps/connect
pnpm exec wrangler d1 create gardener-connect
pnpm exec wrangler d1 migrations apply DB --remote
```

Deploying once before GitHub credentials are installed is safe and gives you a stable workers.dev URL. `/health` returns `503` until configuration is complete.

```bash
pnpm exec wrangler deploy
```

## 2. Create one GitHub App

The repository includes a GitHub App Manifest helper. Run it once with the public Connect origin:

From the repository root:

```bash
node scripts/create-github-app.mjs https://connect.example.com
```

GitHub asks for one browser confirmation and returns the App credentials to the local helper. They are written with owner-only permissions to:

```text
~/.config/gardener/github-app.json
```

The App uses:

- OAuth callbacks: `/v1/landing/callback` and `/v1/auth/github/callback`
- setup callback: `/v1/installations/callback`
- webhook: `/github/webhook`
- repository permissions: Metadata read; Administration, Checks, and Commit statuses read; Contents, Issues, and Pull requests read/write
- issue and pull-request webhooks; GitHub App installation lifecycle events are implicit

Record the returned App ID, client ID, slug, client secret, PEM private key, and webhook secret. Never commit the credential file. When expanding permissions on an existing App, each installation owner must approve the new permissions before Connect can mint tokens for those operations.

## 3. Configure keys and secrets

Generate a Connect JWT key pair that is distinct from the GitHub App key:

```bash
mkdir -p ~/.config/gardener/connect
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out ~/.config/gardener/connect/jwt-private.pem
openssl pkey -in ~/.config/gardener/connect/jwt-private.pem -pubout \
  -out ~/.config/gardener/connect/jwt-public.pem
openssl rand -hex 32
```

Set these non-secret Wrangler variables from the App and deployment:

- `GITHUB_CLIENT_ID`
- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `CONNECT_ISSUER`
- `CONNECT_AUDIENCE`
- `CONNECT_JWT_KID`
- `GITHUB_OAUTH_CALLBACK_URL`
- `DEPLOY_REPOSITORY_URL`

Upload these with `wrangler secret put`:

- `ADMIN_BOOTSTRAP_SECRET`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `CONNECT_JWT_PRIVATE_KEY`
- `CONNECT_JWT_PUBLIC_KEY`

For example:

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

## 4. Verify Connect

The public endpoints must work without a Cloudflare Access login:

```bash
curl -f https://connect.example.com/health
curl -f https://connect.example.com/.well-known/jwks.json
```

`/health` should report `ok: true`, `database: true`, and `configured: true`. The JWKS response must contain the configured `CONNECT_JWT_KID`.

Open the Connect origin in a browser and complete the landing flow. It produces the one Gardener instance token needed by the customer deployment.

## 5. Point Gardener at self-hosted Connect

In the customer Gardener configuration, set both values to the same Connect origin:

```json
{
  "vars": {
    "CONNECT_URL": "https://connect.example.com",
    "CONNECT_ISSUER": "https://connect.example.com"
  }
}
```

Set the generated instance token as `GARDENER_INSTANCE_TOKEN`, deploy Gardener, and select **Configure Gardener**. Gardener discovers the signing key from Connect's JWKS endpoint unless `CONNECT_PUBLIC_KEY` is explicitly pinned.

## Operational hardening

Before opening Connect broadly:

- apply rate limiting or WAF controls to `/v1/bootstrap` without blocking GitHub callbacks or `/github/webhook`;
- enable Worker logs and alert on webhook relay failures;
- restrict GitHub App permissions to the documented minimum;
- rotate GitHub and Connect signing keys deliberately;
- back up D1 and apply numbered migrations before deploying upgrades;
- keep Connect and Gardener on independently deployable release paths;
- test revocation by removing a repository and uninstalling the GitHub App.

The managed and self-hosted modes use the same contracts and security checks. Self-hosting changes who operates the credential boundary; it does not move credentials into Gardener.
