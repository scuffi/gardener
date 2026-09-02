# Gardener

Gardener is a repository-maintenance agent that users deploy into their own Cloudflare account. It observes GitHub issue events, runs a bounded Workers AI workflow, and turns agent output into typed operations that can be disabled, approved by a human, or executed automatically.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/scuffi/gardener)

> **First iteration:** issue classification, labels, bounded comments, close/reopen, approvals, audit, and global pause are implemented. Computer workspaces, code changes, pull requests, reviews, schedules, and merge are deliberately deferred. See [`docs/first-iteration.md`](docs/first-iteration.md).

## How it is managed

This repository contains both deployment boundaries:

- **`apps/connect`** is operated centrally by the Gardener team. It owns the shared GitHub App and is the only component that can mint GitHub installation tokens.
- **`apps/gardener`** is deployed into each user's Cloudflare account. It owns workflows, policy, Workers AI execution, runs, approvals, and audit history.
- **`packages/contracts`** defines signed events, scoped grants, workflows, policies, runtime results, and typed operations.
- **`packages/core`** implements immutable workflow compilation, policy evaluation, stable IDs, and the initial replaceable agent runtime.

GitHub credentials never enter the customer Worker, browser, model prompt, or agent workspace. See [`docs/architecture.md`](docs/architecture.md) and [`SECURITY.md`](SECURITY.md).

## User deployment

Once the managed Connect Worker is running:

> The development repository is currently private. Cloudflare's Deploy button requires a public GitHub or GitLab source, so the button becomes shareable when this repository is made public or moved to its final public home. Direct Wrangler deployment remains available during private development.

1. Open the Connect landing page and continue with GitHub.
2. Gardener creates a one-time `GARDENER_INSTANCE_TOKEN`; select **Copy token & deploy to Cloudflare** and paste that single secret when prompted.
3. Cloudflare provisions the Worker, D1 database, Queue, dead-letter Queue, static assets, and Workers AI binding.
4. Open the deployed Worker and select **Configure Gardener**.
5. The guided setup confirms the owner, opens the shared GitHub App repository picker, synchronizes every selected repository, and offers three understandable automation profiles.
6. Select **Activate Gardener**. The selected policies, Issue Gardener workflow, and global activity are configured together; no manual settings tour is required.

The bootstrap token carries its non-secret instance ID, so no second instance identifier is required. Connect stores only its SHA-256 hash. The customer Worker discovers Connect's public signing key from JWKS.

The root `wrangler.jsonc` is the customer deployment configuration. It automatically provisions D1, a Queue and dead-letter Queue, static assets, and Workers AI. Gardener installs its idempotent initial D1 schema on first use, so a fresh deployment does not require a local migration command. Later numbered schema upgrades must run `pnpm exec wrangler d1 migrations apply DB --remote` (or an equivalent managed deploy step) before the updated Worker is released.

Before publishing under a different repository URL, update the deploy badge and `DEPLOY_REPOSITORY_URL` in `apps/connect/wrangler.jsonc`.

## Operating Connect

Create one managed GitHub App with:

- Callback URLs: `https://<connect-host>/v1/landing/callback` and `https://<connect-host>/v1/auth/github/callback`
- Setup URL: `https://<connect-host>/v1/installations/callback`
- Webhook URL: `https://<connect-host>/github/webhook`
- Repository permissions: **Metadata: read**, **Issues: read and write**
- Events: **Issues**, **Installation**, and **Installation repositories**

Create a D1 database, configure its ID in `apps/connect/wrangler.jsonc`, apply `apps/connect/migrations`, and set the secrets listed in `apps/connect/.dev.vars.example`. The Connect JWT signing key and GitHub App private key must be separate RSA keys.

```bash
pnpm install
pnpm --filter @gardener/connect db:migrate
pnpm deploy:connect
```

The public `/v1/bootstrap` endpoint only creates an inert instance record and one-time token; it grants no GitHub access. Apply Cloudflare rate limiting/WAF policy to that endpoint before a broad public launch.

## Local development

Requirements: Node.js 22+, pnpm 11.25.0, and a Cloudflare account.

```bash
pnpm install
cp apps/connect/.dev.vars.example apps/connect/.dev.vars
cp apps/gardener/.dev.vars.example apps/gardener/.dev.vars
pnpm --filter @gardener/connect db:migrate:local
pnpm --filter @gardener/app db:migrate:local
```

Run Connect and Gardener in separate terminals, using different ports and local URLs in their development variables:

```bash
pnpm --filter @gardener/connect exec wrangler dev --port 8788
pnpm --filter @gardener/app exec wrangler dev --port 8787
```

## Validation

```bash
pnpm check
pnpm smoke:onboarding
```

`smoke:onboarding` launches a local Connect simulator, a fresh local Gardener Worker, and headless Chrome. It drives the real account → repository picker → automation profile → live dashboard flow, verifies two synchronized repositories and the safe policy preset, and creates no GitHub App or remote Cloudflare resource. Set `CHROME_BIN` when Chrome is installed outside the standard macOS path.

The `check` command:

1. Verifies every dependency is pinned to the latest npm release.
2. Typechecks every workspace.
3. Runs contract, core, Connect, and Gardener tests.
4. Performs dry-run Wrangler builds for both Workers.

Versions are exact and checked automatically; Dependabot also scans the workspace weekly. Current Cloudflare Agents, Computer, Sandbox, Wrangler, and Workers type releases were checked explicitly. After deploying, use **Settings & health → Test deployed model** to run the exact Workers AI JSON Schema request against the hosted model without creating a GitHub operation; a dry-run build cannot replace that deployed smoke test. See [`docs/version-policy.md`](docs/version-policy.md).

## License

Apache-2.0
