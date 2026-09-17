# Actions v1 transport live qualification

Date: 2026-09-17

## Pinned Gardener components

- Planning runner/action commit: `fc46492dde64a0fd2f6a48cc41c7f926df39241f`
- Planning reusable workflow commit: `bd6ac76f84e5969797507bd8ab52b97afceac05b`
- OIDC replay probe/action commit: `ffa37e44942e42ca9f97c3714f06d88abeb77de7`
- Phase-capable OIDC probe commit: `72c265f69ab323071ebf1a5c8db19b58127cafe8`
- OIDC replay reusable workflow commit: `c9ba5c23efec1cb552ff0c66821f9e27365c238c`
- Runner: fixed `ubuntu-24.04` GitHub-hosted runner
- Checkout: `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803` (`v6.1.0`)

## Public edge Worker

- Worker: `gardener-actions-v1-spike`
- Endpoint: <https://gardener-actions-v1-spike.agents-b8a.workers.dev>
- Latest qualified version: `d92156d6-3639-464d-a95d-5d7bc10ea49e`
- Binding: SQLite Durable Object `SESSIONS` / `SpikeSession`
- Current enrollment: public repository ID `1374842705`, owner ID `45369682`
- Current trusted workflow: `scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener-reusable.yml@9d0324729f5caa5c31a9517c846b95d8dffec76e`

The entire isolated spike Worker was made public for qualification. It holds no GitHub token, GitHub App key, UI, or administrative API. Public routes are health and Cap'n Web session establishment; `/invoke` and `/state` return `404` outside localhost.

## Repositories

### Private

- Repository: `scuffi/gardener-actions-v1-private-smoke`
- Numeric repository ID: `1374701263`
- Numeric owner ID: `45369682`
- The private Gardener repository's Actions access level was changed from `none` to `user` so this repository could consume the pinned private workflows and actions.

### Public

- Repository: `scuffi/gardener-actions-v1-public-smoke`
- Numeric repository ID: `1374842705`
- Numeric owner ID: `45369682`
- Public runner action commit: `4ef4b1b0d9e7bbb2858d17168d08eec9b1552ac3`
- Public reusable workflow commit: `9d0324729f5caa5c31a9517c846b95d8dffec76e`
- Public effects probe action commit: `f2e699efdf8165477ffcbe2d3affd4cfc9a81f24`
- Public effects reusable workflow commit: `acb13ef9f0e18fca43f46d055539cc75c59315c3`

## Positive live qualifications

### Private repository, direct edge Worker

Run: <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35250252931>

This run proved real GitHub OIDC signature and claim verification, private checkout, exact reusable-workflow binding, an outbound Cap'n Web WebSocket, Worker-to-runner shell callback, bounded result return, and a completed Durable Object operation. The job's GitHub token permissions were `Contents: read` plus implicit metadata read, and checkout used `persist-credentials: false`.

### Edge script deployment during a running callback

Run: <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35251330181>

The Worker dispatched a 28-second action that created a replay marker. A new Worker version was deployed while that callback was running. The GitHub Action logged a WebSocket disconnection, acquired a fresh OIDC token and Cap'n Web session, waited for the still-running runner-local operation, and reconciled it into the original Durable Object action record. The new Worker loaded the original durable action definition instead of reconstructing it from new script code.

Result: `edge-deployment-reconciled-without-replay` with one reconnect and no replay-marker failure.

An earlier forced deployment run, `35250794056`, correctly exposed an `Operation ID conflict`: the spike reconstructed a changed hard-coded action after deployment. Commit `106913000a4a1b896f319e6d148d4f341bed1079` fixed this by loading the original action definition from Durable Object storage. The successful run above is the regression qualification.

### One-time OIDC replay defense

Run: <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35255539328>

A trusted probe obtained one real GitHub OIDC token, authenticated successfully, disconnected, and attempted a second authentication with the same signed token against the same deterministic Durable Object session. The second authentication was rejected with `OIDC token was already used` and the workflow succeeded only after observing that rejection.

### Public repository

Initial run: <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35255939263>

Independent repeat: <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35256179260>

Both public-repository runs completed through the full-SHA-pinned public reusable workflow and action with `Contents: read`, real GitHub OIDC, edge Durable Object routing, Cap'n Web callback, and `github-actions-capnweb-ok`. The repeat used a distinct run/session and demonstrates run isolation rather than stale session reuse.

### Environment-bound effects identity

Run: <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35257188403>

An automatic `gardener-effects` GitHub Environment produced a real OIDC token carrying the environment claim. The probe presented `phase: effects`; the Worker required the exact trusted effects reusable workflow and `environment: gardener-effects`, authenticated it successfully, then rejected reuse of the same effects token. The job had only implicit metadata read and `id-token: write`; it had no checkout or shell executor. This qualifies cryptographic separation of planning and effects identities, but not effect execution itself.

### Result bounds and shell lifecycle

- Run `35254493290`: a 100,000-byte shell output completed; the Action result was bounded and the terminal summary was exactly 16,384 characters.
- Run `35254679602`: shell exit code 42 propagated as an expected workflow failure with `forced-shell-failure`.
- Run `35254853133`: a 60-second command was terminated by the 30-second action timeout and propagated as `timed_out`.
- Runner unit tests also cover active process-group cancellation, forced timeout termination, combined output bounds, credential-environment scrubbing, workspace path confinement, and operation-ID conflict detection.

## Negative live qualifications

- A signed token from a non-allowlisted reusable workflow was rejected in run <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35254311053> with `Runner hello does not match the trusted reusable workflow`.
- After enrollment moved to the public repository, the otherwise valid private workflow was rejected in run <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35256032642> with `Runner hello does not match enrolled repository identity`.
- The public edge rejected an unsigned token and a mismatched routed session in `test/edge-negative-client.ts`.
- A WebSocket frame larger than 1 MiB was closed with code 3000 and `Incoming message exceeds maximum size`.
- Public `/state/*` and `/invoke/*` requests returned `404`.

## Previously resolved ingress issue

The account initially placed both the default `workers.dev` endpoint and an experimental custom domain behind Cloudflare Access, producing `302` before requests reached the Worker. The custom domain was removed. Access was then disabled for the isolated `gardener-actions-v1-spike.agents-b8a.workers.dev` Worker, and direct edge qualification succeeded. No Access credential is present in a planning job.

## Remaining v1 work

The mandatory public edge Cap'n Web/OIDC/reconnect gate is now qualified for public and private GitHub.com repositories. This spike does not yet prove the complete product:

- Flue/Workers AI orchestration is not connected to the Session Durable Object.
- Heartbeats, output streaming/backpressure, and server-driven cancellation are not live-qualified.
- The clean D1 run/effect/audit schema is not implemented.
- `.gardener/` compilation and deterministic generated workflows are not implemented.
- The full-Git-semantics artifact contract and privileged effect executor are not implemented.
- Issue-to-draft-PR effects, default bot identity, and optional customer GitHub App identity remain unqualified.

## Repository validation

After live qualification, `pnpm check` passed across the monorepo, including:

- Protocol: 2 files / 7 tests.
- Runner: 2 files / 9 tests.
- Actions spike OIDC unit suite: 13 tests.
- Real local Wrangler/Cap'n Web/bundled-Action integration.
- Historical contracts: 10 tests; core: 16 tests; provider GitHub: 5 tests; CLI: 11 tests; Gateway: 33 tests; Gardener: 54 files / 305 tests.
- Typechecks, package builds, Worker build, deployment dry-runs, and historical topology validation.
- `actionlint` for every spike and smoke workflow.
- Online `zizmor --persona=pedantic` with no unignored findings.
- Deterministic rebuild comparison for both bundled JavaScript Actions.
- Production dependency audit with no known vulnerabilities.
- `git diff --check`.
