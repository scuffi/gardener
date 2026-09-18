# Actions v1 transport live qualification

Date: 2026-09-17

## Actions-native issue-triage product proof (2026-09-18)

Successful workflow run (attempt 16): <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35327258456>

Trigger issue: <https://github.com/scuffi/gardener-actions-v1-public-smoke/issues/2>

Exact bot comment: <https://github.com/scuffi/gardener-actions-v1-public-smoke/issues/2#issuecomment-5731407050>

This run qualified the concrete MVP path:

- an `issues: opened` event carrying the pre-existing `gardener-test` label invoked a full-SHA-pinned reusable workflow;
- the planning job used `ubuntu-24.04`, `contents: read`, `id-token: write`, and checkout with `persist-credentials: false`;
- GitHub OIDC authenticated the numeric repository and owner IDs, run attempt, event, ref, SHA, hosted runner, audience, and reusable-workflow commit;
- the Gardener Worker invoked a fixed repository listing through the Cap'n Web runner before Flue inference;
- Flue and Workers AI emitted one schema-validated `issue.comment.create` proposal;
- planning uploaded canonical `gardener.task-effect-plan/v1` JSON addressed by SHA-256;
- the checkout-free effects job used `issues: write` and `id-token: write`, revalidated the artifact, and posted the exact body as `github-actions[bot]`;
- the comment carries `<!-- gardener-operation:op_7a46cbf67042cd1345a29652564b8526c7143aa28a1a2584b795ee9f304cbe34 -->` for reconciliation;
- D1 persisted the completed model outcome and `gardener.runner.effect-receipt/v1`, including artifact digest `a2ca12d791ccf0d0cd7f98f90299f4aa95034e93ec1a0e7308d27d310ca1e698` and GitHub comment ID `5731407050`;
- the deployed Runs UI consumes `/api/actions/runs` and renders the model summary, proposed comment, and receipt link.

Pinned smoke components:

- bundled runner/effects Actions: `1e60ff1c6cb43e8c0872bc5e264d4d4d8b37d6e9`;
- reusable two-job workflow: `ba368dd86dcb8be97a096f6211602ab93f9819ce`;
- caller workflow revision used by the proof: `fa86fda`;
- task bundle hash: `d3ea6c38276b0e67f6757354abbd60afc596eaafd0702622eaa8ca95499f849f`.

Deployed product resources:

- runtime Worker: `gardener-actions-v1-runtime`, version `20256bf6-f679-47e8-8f69-ee99d3077fd9` at the successful proof;
- isolated D1 database: `gardener-actions-v1-runtime` (`e5b4c408-55d6-42f7-802e-93542cf93877`), schema version 10;
- public ingress: the previously qualified `gardener-actions-v1-spike` hostname now forwards only `/session/<id>` to `GardenerRunnerIngressEntrypoint`; product-forwarding version `be74cb4e-4dea-423f-b4c4-fd463308df3e`.

Attempts 1–15 were diagnostic, not accepted proofs. They exposed and resolved: account Access interception on a newly created ingress hostname, non-fetch RPC WebSocket response serialization, missing `fetch()` on the service entrypoint, a Flue model that required explicit native `tool_choice`, a Flue continuation payload incompatibility, canonical tool-result publication failure, and a preflight path of `.` rejected by repository confinement. The successful attempt used fixed host-driven Cap'n Web inspection followed by one forced, validated terminal model tool; the privileged job still received only the resulting exact artifact.

## Clean confirmation and readiness findings (2026-09-18)

The qualified ingress and runtime subsequently completed clean, first-attempt runs without deployment, enrollment, SQL, or operator intervention:

- public run <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35357839645> produced <https://github.com/scuffi/gardener-actions-v1-public-smoke/issues/3#issuecomment-5731638770>;
- private run <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35358046389> produced <https://github.com/scuffi/gardener-actions-v1-private-smoke/issues/1#issuecomment-5731666007>;
- after an unsuccessful canonical-Flue experiment was rolled back, public run <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35364105032> completed on attempt 1 and produced <https://github.com/scuffi/gardener-actions-v1-public-smoke/issues/6#issuecomment-5732426955>.

A dedicated `gardener-runner-ingress` Worker was deployed and both enrollments were temporarily moved to its audience. Public run `35358427732` and private run `35359447838` each failed before reaching the Worker after repeated WebSocket connection attempts. Direct requests to `gardener-runner-ingress.agents-b8a.workers.dev` receive an account-level Cloudflare Access `302`; the same service-binding forwarding code works at the public `gardener-actions-v1-spike` hostname. Both callers and enrollments were restored to the qualified hostname. Removing that Access interception is an account-policy prerequisite, not a Worker code change.

Canonical Flue continuation was also re-investigated in attempts 1–9 of run `35360919894`. Normalizing a Workers AI tool-call finish from `stop` to `toolUse` allowed Flue to persist the assistant/tool-result turn, proving the earlier conversation-stream invariant was caused by the provider finish reason. The next model turn then failed at the Workers AI binding boundary: the Llama chat-completions wire rejected its multi-turn assistant/tool transcript, while GPT-OSS Responses requests reached the native endpoint with function tools transformed back to a nested chat-completions shape and were rejected with validation error `8007`. Disabling the default AI Gateway did not change the result. The experiment was fully rolled back; deployed runtime version `8a5e7b25-7ca4-4d7a-83b6-e01090d63248` restores the qualified preflight/forced-terminal/direct-D1 behavior. Canonical tool-result delivery therefore remains an explicit upstream/provider-integration blocker rather than a completed readiness gate.

The CLI now removes hand-written enrollment SQL and hand-authored caller YAML from the repeatable path:

```sh
pnpm --filter @gardener/cli build
node packages/cli/dist/cli.js actions workflow \
  --workflow-ref OWNER/ACTIONS_REPOSITORY/.github/workflows/gardener-triage-reusable.yml@FULL_SHA \
  --audience https://RUNNER_INGRESS \
  --task-bundle-hash SHA256 \
  --output ../customer-repository/.github/workflows/gardener-triage.yml
node packages/cli/dist/cli.js actions enroll \
  --repository OWNER/CUSTOMER_REPOSITORY \
  --workflow-ref OWNER/ACTIONS_REPOSITORY/.github/workflows/gardener-triage-reusable.yml@FULL_SHA \
  --audience https://RUNNER_INGRESS \
  --config apps/gardener/wrangler.jsonc
```

`actions enroll` resolves immutable numeric repository and owner IDs from GitHub and performs an idempotent D1 upsert. `actions disable` is the non-destructive enrollment rollback. The generator was checked byte-for-byte against the qualified private caller, and `actions enroll` was run successfully against the existing private enrollment. D1 creation/migrations, Worker deployment, immutable Actions release publication, and end-to-end qualification still need to be composed around these primitives before setup is fully reproducible.

## Historical transport qualification (2026-09-17)

### Pinned Gardener components

- Planning runner/action commit: `fc46492dde64a0fd2f6a48cc41c7f926df39241f`
- Planning reusable workflow commit: `bd6ac76f84e5969797507bd8ab52b97afceac05b`
- OIDC replay probe/action commit: `ffa37e44942e42ca9f97c3714f06d88abeb77de7`
- Phase-capable OIDC probe commit: `72c265f69ab323071ebf1a5c8db19b58127cafe8`
- OIDC replay reusable workflow commit: `c9ba5c23efec1cb552ff0c66821f9e27365c238c`
- Runner: fixed `ubuntu-24.04` GitHub-hosted runner
- Checkout: `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803` (`v6.1.0`)

### Public edge Worker

- Worker: `gardener-actions-v1-spike`
- Endpoint: <https://gardener-actions-v1-spike.agents-b8a.workers.dev>
- Latest qualified version: `d92156d6-3639-464d-a95d-5d7bc10ea49e`
- Binding: SQLite Durable Object `SESSIONS` / `SpikeSession`
- Current enrollment: public repository ID `1374842705`, owner ID `45369682`
- Current trusted workflow: `scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener-reusable.yml@9d0324729f5caa5c31a9517c846b95d8dffec76e`

The entire isolated spike Worker was made public for qualification. It holds no GitHub token, GitHub App key, UI, or administrative API. Public routes are health and Cap'n Web session establishment; `/invoke` and `/state` return `404` outside localhost.

### Repositories

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

### Positive live qualifications

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

### Negative live qualifications

- A signed token from a non-allowlisted reusable workflow was rejected in run <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35254311053> with `Runner hello does not match the trusted reusable workflow`.
- After enrollment moved to the public repository, the otherwise valid private workflow was rejected in run <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35256032642> with `Runner hello does not match enrolled repository identity`.
- The public edge rejected an unsigned token and a mismatched routed session in `test/edge-negative-client.ts`.
- A WebSocket frame larger than 1 MiB was closed with code 3000 and `Incoming message exceeds maximum size`.
- Public `/state/*` and `/invoke/*` requests returned `404`.

### Previously resolved ingress issue

The account initially placed both the default `workers.dev` endpoint and an experimental custom domain behind Cloudflare Access, producing `302` before requests reached the Worker. The custom domain was removed. Access was then disabled for the isolated `gardener-actions-v1-spike.agents-b8a.workers.dev` Worker, and direct edge qualification succeeded. No Access credential is present in a planning job.

### Remaining v1 work recorded on 2026-09-17

The mandatory public edge Cap'n Web/OIDC/reconnect gate is now qualified for public and private GitHub.com repositories. This spike does not yet prove the complete product:

- Flue/Workers AI orchestration is not connected to the Session Durable Object.
- Heartbeats, output streaming/backpressure, and server-driven cancellation are not live-qualified.
- The clean D1 run/effect/audit schema is not implemented.
- `.gardener/` compilation and deterministic generated workflows are not implemented.
- The full-Git-semantics artifact contract and privileged effect executor are not implemented.
- Issue-to-draft-PR effects, default bot identity, and optional customer GitHub App identity remain unqualified.

### Repository validation

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
