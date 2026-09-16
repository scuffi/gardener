# Foundation status

Updated for the customer-owned GitHub Gateway cutover. This page distinguishes implemented code from
qualified production behavior. Nothing here authorizes a production deployment.

## Implemented locally

### Workspace and identity

- One Gardener D1 is one workspace; no internal tenant discriminator.
- Provider-neutral users, immutable external subjects, owner/member memberships, invitations, and
  permanent-owner database protection.
- Random provider login handoffs stored only as hashes and consumed once.
- Opaque hashed dashboard sessions with 30-minute idle and eight-hour absolute limits.
- Dashboard, MCP, and local-development principal kinds cannot substitute for one another.
- MCP remains owner-revalidated and draft/read/validate/simulate only.

### Agent authority

- Repository-independent `gardener.agent/v1` revisions.
- One active revision pointer per Agent.
- Disabled-by-default exact repository assignments as the sole runtime enablement gate.
- Workspace and repository policies, immutable assignment/policy run bindings, and live-state
  narrowing.
- “All current” materialization that does not follow future repositories.
- Canonical advisory overlap warnings with exact fresh confirmation.
- Owner/member controls where members may propose and narrow but not widen.

### GitHub Gateway

- `apps/connect` removed and replaced by `apps/github-gateway`.
- Dedicated customer-owned Worker/D1/App boundary with no instance token, customer JWT, JWKS,
  callback registration, or tenant columns.
- Named `GitHubGatewayEntrypoint` and `GardenerGitHubEntrypoint` RPC contracts.
- OAuth identity proof with temporary token used only for `/user`.
- Personal/organization installation flows bound to the initiating owner's immutable subject.
- Multiple active installations and fenced repository synchronization.
- Verified, size-bounded webhook normalization and durable `202` acceptance.
- Direct `waitUntil` delivery with attempt-token fencing, diagnostics, and explicit retry.
- All 29 operation contracts retained; exactly 12 verified executors advertised available and 17
  unavailable.
- Event/repository/resource-bound operation claims, canonical hashes, provider preconditions,
  receipt leases, reconciliation, and hash-bound replay.
- Host-generated exact comment marker for ambiguous-outcome recovery.

### Setup and operations

- `gardener setup` with owner resolution/confirmation, workspace-specific Cloudflare names,
  ordered shell/Gardener/linked-Gateway deployment, App Manifest creation, direct secret upload, and
  resumable owner-only checkpoints.
- `gardener gateway doctor` and explicit `gardener gateway retry <delivery-id>`.
- Temporary `setup-recovery.json` retained after partial failure and deleted only after verification.
- Independent local Gateway operator token accepted only by sanitized doctor/retry routes.
- Workers.dev origins only; custom-domain provisioning deferred.

### Runtime

- The implemented bounded path is:
  `github.issue.opened` → direct keyed Flue dispatch → one native model turn →
  `submit_gardener_output_v1` → exact `issue.comment.create` → Gateway receipt.
- Native runs use immutable `flue-native-v1`; historical `workflow-v1` rows remain readable but
  cannot be resumed by native code.
- D1 atomically admits the run, exact request, and outbox while freezing authority, model, profile,
  and request protocol. It also owns canonical output, effect/receipt projection,
  cancellation, product status, and audit. Flue owns conversation, turn, and durable-tool state.
- The static Flue recovery ceiling is explicit at three attempts/15 minutes. The provider rejects a
  durable-context second turn; terminal host failures terminate without becoming model-visible retries,
  and a product singleton admits at most one terminal call to effect work.
- A one-minute, leased, model-free D1/Cron reconciler repairs missing dispatch receipts and abnormal
  settlements. Ordinary Agent runs create no Cloudflare Workflow.
- The trusted terminal tool retries only the same frozen exact operation, re-reading live authority
  before every actual Gateway attempt. Effect creation/claim are database cancellation-fenced. Every
  abandonment becomes non-active; possibly applied calls use unknown-outcome plus one Inbox item.
  Cron does not execute effects.
- Runtime cancellation intent and its deduplicated audit are one active-state-fenced D1 batch before
  native abort, and immediately deny new effects.
- `pnpm preflight:flue-native -- --output <manifest>` must pass while globally paused before cutover;
  it rejects any active historical `workflow-v1` run.

## Locally validated

The monorepo has contract, core, Gateway, Gardener, CLI, migration, runtime, state-machine, UI,
accessibility, and operation-executor tests. TypeScript builds and Wrangler dry deployments are part
of `pnpm check`. Current counts are reported by the command rather than frozen in this document.

Important tests cover:

- 12/17 capability truthfulness;
- webhook signature/body binding, durable ignored records, failure persistence, fencing, and retry;
- operation event binding, operation-ID conflicts, exact replay, and receipt integrity;
- permanent owner and immutable-subject invitation login;
- opaque session expiration/revocation;
- owner-bound installation finalization in the browser flow;
- direct keyed Flue dispatch, native tool payload preservation, explicit durability, and frozen deadlines;
- D1 outbox fencing, cancellation ordering, abnormal settlement, and exact-operation retry;
- CLI private file modes, deterministic resource names, and App Manifest boundaries.

## Not yet remotely qualified

No claim is made yet that the new topology works on real customer resources. Explicit approval is
required before validating:

- both named Service Binding entrypoints;
- circular binding deployment order;
- public route versus RPC isolation;
- personal and organization App creation;
- multiple installations and repository synchronization;
- owner, invited member, and rejected identity login;
- webhook `waitUntil` failure followed by explicit retry;
- direct Flue continuation after ingress returns and keyed receipt adoption after simulated D1 loss;
- durable terminal-tool recovery, failed/aborted Cron settlement, and cancellation before effect;
- exact operation replay with no duplicate comment and no Workflow participation;
- secret/recovery cleanup and operator-token rotation;
- full migration and no-container deployment behavior.

The existing production Gardener remains on schema 6, globally paused, and unchanged. The old managed
Connect deployment must not onboard new customers and is retired only after the customer-owned
Gateway is independently qualified.

## Deliberately unavailable

- Approval-mode runtime effects.
- Trusted tool loops and a provisioned narrowed `GARDENER_HARNESS_TOOLS` facade.
- Human-input interruption/resumption and approval-mode continuation.
- General trusted observation/workspace tools and multi-effect sequencing.
- Exact-SHA Computer workspaces, typed `commitSha`, branch/commit/draft-PR fix flows, and retained
  artifact qualification.
- Channel adapters, channel schemas, channel credentials, or channel UI.
- Custom-domain setup.
- OAuth MCP until `OAUTH_KV` is provisioned.

Contracts or UI placeholders do not make these features live. Missing integration fails closed.

## Release blockers

1. Run full local validation and both Worker dry deployments.
2. Obtain an independent whole-change security/architecture review and address issue scope.
3. Obtain explicit approval for real Cloudflare/GitHub resources.
4. Qualify the new stack end-to-end, including failures and replay.
5. End qualification with `global_paused=true`.
6. Update the reviewed commit chain and only then decide whether to push and retire managed Connect.

See [Architecture](architecture.md), [Gateway runbook](github-gateway.md), and
[Security](../SECURITY.md).
