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

A dedicated `gardener-runner-ingress` Worker was deployed and both enrollments were initially moved to its audience. Public run `35358427732` and private run `35359447838` failed before reaching the Worker after repeated WebSocket connection attempts because an account-level Cloudflare Access policy returned `302`. An exact-host bypass was subsequently added for `gardener-runner-ingress.agents-b8a.workers.dev`. The endpoint now returns its own `200` health response and completes an unauthenticated HTTP/1.1 WebSocket upgrade with `101`; authentication remains mandatory inside the Cap'n Web session.

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

`actions enroll` resolves immutable numeric repository and owner IDs from GitHub and performs an idempotent D1 upsert. `actions disable` is the non-destructive enrollment rollback. The generator was checked byte-for-byte against the qualified private caller, and `actions enroll` was run successfully against the existing private enrollment. D1 creation/migrations, Worker deployment, and end-to-end qualification still need to be composed around these primitives before setup is fully reproducible.

Gardener-owned release assets are now published in the public, branch-protected repository <https://github.com/scuffi/gardener-actions>:

- bundled runner/effects Actions commit: `71ec3e643887d8952ab780da42f406e7b234f1bb`;
- reusable workflow commit: `1069cbd7317970865e4366d99eb7c711df9ccee6`;
- release: <https://github.com/scuffi/gardener-actions/releases/tag/v1.0.0>.

The bundled files are byte-identical to the qualified Action commit. `main` requires a code-owner review, stale-review dismissal, last-push approval, conversation resolution, linear history, and administrator enforcement; force pushes and deletion are disabled. Consumers still pin commit SHAs rather than the mutable tag. This release repository is public because GitHub does not let arbitrary public or cross-owner customer repositories consume reusable workflows and Actions from the private Gardener source repository. It contains only releasable code and no credentials, deployment configuration, or customer data.

The generated callers and D1 enrollments were migrated to the Gardener-owned workflow SHA. Both release confirmation runs succeeded on attempt 1:

- public run <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35366056947> produced <https://github.com/scuffi/gardener-actions-v1-public-smoke/issues/7#issuecomment-5732670231>;
- private run <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35366057486> produced <https://github.com/scuffi/gardener-actions-v1-private-smoke/issues/3#issuecomment-5732671762>.

Both D1 rows are completed, are bound to run attempt 1, and contain effect receipts pointing to those exact `github-actions[bot]` comments.

After the Access bypass, both generated callers and D1 OIDC audiences were moved to the dedicated ingress. The final dedicated-ingress confirmations also succeeded on attempt 1:

- public run <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35367007114> produced <https://github.com/scuffi/gardener-actions-v1-public-smoke/issues/8#issuecomment-5732798865>;
- private run <https://github.com/scuffi/gardener-actions-v1-private-smoke/actions/runs/35367009092> produced <https://github.com/scuffi/gardener-actions-v1-private-smoke/issues/4#issuecomment-5732791805>.

The planning and effects jobs used `https://gardener-runner-ingress.agents-b8a.workers.dev` as both transport origin and OIDC audience. Their completed D1 rows include exact comment receipts. The `gardener-actions-v1-spike` service binding to the product runtime was then removed and the transport-only spike redeployed as version `c49bbac8-513b-4184-907c-246d9e5d1d93`; it is no longer a product forwarding path.

## Exact-effect negative and reconciliation qualification (2026-09-18)

Public run <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35368619328> executed the pinned released effects Action against three invalid artifacts. It observed the exact failures `Effect artifact digest mismatch`, `Effect repository binding mismatch`, and `Effect issue binding mismatch`. The qualification issue received zero comments, and each rejection happened before GitHub API or receipt recording. The job had no checkout; its write-capable token was passed only to the released effects Action, never to a shell step. The workflow source is `qualification/effects-negative.yml`.

Public run <https://github.com/scuffi/gardener-actions-v1-public-smoke/actions/runs/35369214475> executed one valid SHA-256-bound artifact twice in the same checkout-free effects job. Both executions returned operation `op_f2f365045ffddc7f04bf2957bb327f946b07c149d52036988999321e0bc2605a` and comment ID `5733064172`. Issue <https://github.com/scuffi/gardener-actions-v1-public-smoke/issues/12> contains exactly one marked `github-actions[bot]` comment, D1 contains one matching receipt, and the immutable audit log contains exactly one `effect.executed` event. The second execution therefore reconciled rather than posting or auditing a duplicate. The reusable workflow source is `qualification/effects-reconcile-reusable.yml`.

The temporary reconciliation enrollment was restored to the Gardener-owned reusable workflow immediately after qualification. Public and private product enrollments both remain on the dedicated ingress and release workflow SHA.

## Access-authenticated Actions dashboard qualification (2026-09-21)

The dashboard now uses Cloudflare Access as its application identity boundary instead of requiring the archived reciprocal GitHub Gateway login. Gardener verifies the Access JWT signature and exact issuer, audience, immutable subject, and configured owner email before admitting the permanent owner principal. The full dashboard hostname remains Access-protected; only the dedicated runner ingress retains its exact-host bypass and mandatory in-session GitHub OIDC authentication.

Runtime version `156a0257-2517-469a-9f65-d54753a6c4fc` exposes an explicit `actions-v1` dashboard mode. The authenticated UI skips legacy repository setup, hides legacy Agent/authority surfaces and GitHub controls, and opens a Runs-only product view. Manual browser qualification confirmed the live Actions panel displays the planning summary, proposed comment, full operation ID, full artifact SHA-256, and exact GitHub comment receipt. The UI therefore exposes the persisted outcome and receipt state already proven by the public/private live runs without reconstructing the archived Gateway product.

Independent review found no blocking issue. Follow-up hardening made non-owner Access identities fail as unauthenticated instead of producing a server error, added direct cryptographic tests for signature/algorithm/issuer/audience/expiry enforcement, guaranteed Access logout even when the application POST fails, constrained receipt links to the exact `https://github.com` origin, and added tests for Access precedence and non-owner rejection.

## Reproducible Actions CLI and two-task qualification (2026-09-21)

The Actions-native CLI now scaffolds and strictly compiles `.gardener/tasks/*/TASK.md` into canonical `TaskBundleV1`, SHA-256 hashes, a committed lock, and deterministic caller workflows. Migration 11 stores immutable bundles and per-repository bundle enablement. The authenticated runtime resolves only the requested hash enabled for the numeric OIDC-authenticated repository and recomputes canonical SHA-256 before execution.

A fresh isolated Cloudflare namespace was created using `gardener deploy`:

- D1: `gardener-qual-actions-cli-1`;
- private runtime: `gardener-qual-actions-cli-1-runtime` (`workers.dev` disabled);
- public ingress: `gardener-qual-actions-cli-1-runner-ingress`;
- ingress health: `{"ok":true,"service":"gardener-runner-ingress","runtime":true}`.

The account's wildcard Access application initially intercepted the new ingress. After the exact ingress hostname was made public, rerunning the same checkpointed deploy completed without recreating resources. The CLI also supports creating that exact-host bypass with a local, narrowly scoped Access Apps/Policies API token; the token is never persisted or passed in argv.

The disposable public repository <https://github.com/scuffi/gardener-actions-cli-demo> was initialized, built, connected, committed at `ad18914532d4f09bee7c9346b8c076903cafdde7`, and qualified using only CLI commands. Both independently compiled product tasks succeeded on attempt 1:

- bug intake: run <https://github.com/scuffi/gardener-actions-cli-demo/actions/runs/35593673019>, issue #1, comment `5759675995`, bundle `0c0274da931a3a1b6a4060d178d786fc93e8c64e7966c0791ab5239138d2f94e`;
- documentation helper: run <https://github.com/scuffi/gardener-actions-cli-demo/actions/runs/35593787842>, issue #2, comment `5759684714`, bundle `a6aef615462b99691761520e9ccc8e8e111819cb24f01757fb47e06cd04572f7`.

D1 contained exactly two bundles, two enabled repository mappings, and two effect receipts. A complete `gardener up --demos` rerun completed successfully and left the generated repository byte-clean. `gardener doctor` confirmed the D1, both Workers, ingress, and private runtime binding.

The stack was then destroyed through manifest-guarded `gardener down`, recreated from the same repository and private deployment intent, reconnected, and qualified again. Both recreated-stack workflows succeeded on attempt 1 with the same compiled bundle hashes:

- bug intake: run <https://github.com/scuffi/gardener-actions-cli-demo/actions/runs/35595265570>, issue #3, comment `5759879287`;
- documentation helper: run <https://github.com/scuffi/gardener-actions-cli-demo/actions/runs/35595330810>, issue #4, comment `5759886698`.

This proves clean creation, interruption-safe resume, idempotent rerun, guarded teardown, clean recreation, two-task execution, and exact GitHub/D1 receipt verification. The account-wide Access policy required the recreated ingress Worker to be made public again; runtime and D1 remained private.

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
