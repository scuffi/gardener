# Actions v1 transport live qualification

Date: 2026-09-17

## Pinned components

- Runner/action commit: `fc46492dde64a0fd2f6a48cc41c7f926df39241f`
- Reusable workflow commit: `bd6ac76f84e5969797507bd8ab52b97afceac05b`
- Reusable workflow: `scuffi/gardener/.github/workflows/gardener-reusable-spike.yml`
- Runner: fixed `ubuntu-24.04` GitHub-hosted runner
- Checkout: `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803` (`v6.1.0`)

## Private repository

- Repository: `scuffi/gardener-actions-v1-private-smoke`
- Numeric repository ID: `1374701263`
- Numeric owner ID: `45369682`
- Current qualification workflow: `.github/workflows/gardener.yml`
- The private Gardener repository's Actions access level was changed from `none` to `user` so the smoke repository can consume the pinned private reusable workflow and action.

## Successful real GitHub-hosted runs

### Real GitHub OIDC and Cap'n Web callback

Run: <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35245821468>

The run proved:

- A private repository was checked out with `contents: read` and `persist-credentials: false`.
- The planning job had only `contents: read` and `id-token: write`.
- GitHub issued the job's real OIDC token.
- The harness verified its issuer, audience, signature, expiry, token ID, numeric repository and owner IDs, run ID and attempt, caller workflow ref, exact reusable `job_workflow_ref`, event, ref, SHA, and `github-hosted` runner environment.
- The GitHub-hosted runner opened the outbound Cap'n Web WebSocket.
- The Durable Object invoked the runner's shell callback.
- The shell did not receive `GITHUB_TOKEN` or `ACTIONS_ID_TOKEN_REQUEST_TOKEN` in its environment.
- The action returned `completed` with `github-actions-capnweb-ok`.
- The Durable Object recorded one completed operation at sequence 1.

### Disconnect and Worker-process restart reconciliation

Run: <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35246221526>

The Durable Object first recorded `spike-run-command` as `running`. The local Wrangler Worker process was then killed while the 15-second command continued on the GitHub-hosted runner. A fresh Worker process started against the same SQLite Durable Object storage. The runner reacquired a fresh Cap'n Web session, and the resumed Durable Object queried the runner-local action journal. It reconciled the completed result without invoking the command again.

The run completed with summary `reconnected-without-replay`; durable state contained exactly one completed operation at sequence 1.

## Deployed Cloudflare Worker

- Worker: `gardener-actions-v1-spike`
- Endpoint: `https://gardener-actions-v1-spike.agents-b8a.workers.dev`
- Latest version: `849b2213-47a3-48af-a5a9-a3fa65962b52`
- Binding: SQLite Durable Object `SESSIONS` / `SpikeSession`
- Enrolled numeric repository ID: `1374701263`
- Trusted reusable workflow ref: `scuffi/gardener/.github/workflows/gardener-reusable-spike.yml@bd6ac76f84e5969797507bd8ab52b97afceac05b`

Wrangler deployment and dry-run compilation succeeded. Direct GitHub-hosted access to the default `workers.dev` endpoint currently receives a Cloudflare Access `302` before the Worker. Run `35245227632` therefore failed before WebSocket authentication. A temporary custom domain was tested as a possible Access bypass, produced the same `302`, and was removed. The successful live runs used a temporary public `trycloudflare.com` tunnel to the same local Worker implementation; that tunnel was removed after qualification.

## Remaining release blocker

The deployed edge Worker has **not** yet completed an end-to-end GitHub-hosted session because the account's Access layer intercepts the OIDC-public transport hostname. V1 still requires a dedicated public hostname that bypasses Access and relies on the in-band GitHub OIDC verifier. Once that route exists, rerun the retained private smoke workflow without changing the protocol or credentials.

The restart qualification above exercised local SQLite Durable Object persistence across Worker-process replacement. A deployment restart against a directly reachable edge Durable Object remains required before release.
