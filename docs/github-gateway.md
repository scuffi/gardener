# Operate the customer-owned GitHub Gateway

This document is the V1 setup and recovery runbook. The GitHub Gateway is not a shared Gardener
service. Every Gardener workspace has its own Gateway Worker, D1 database, and GitHub App in the
customer's accounts.

## Trust boundary

The Gateway alone may hold:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `GATEWAY_OPERATOR_TOKEN`
- `OPERATION_MARKER_KEY`

App JWTs and installation tokens are minted in memory, are narrowly permissioned, and are never
persisted or returned. Gardener receives typed identities, repositories, capabilities, events, and
receipts—not credentials or an arbitrary GitHub proxy.

One D1 database is one workspace. There are no tenant columns, instance tokens, shared JWT issuers,
callback registrations, or cross-customer state.

## Public and private interfaces

Public Gateway routes are deliberately small:

| Route | Purpose |
|---|---|
| `GET /health` | Non-secret readiness |
| `GET /oauth/github/callback` | OAuth code and one-use hashed state |
| `GET /installations/github/callback` | Installation setup callback |
| `POST /webhooks/github` | Signed GitHub deliveries |
| `GET /ops/doctor` | Sanitized operator diagnostics |
| `POST /ops/deliveries/:id/retry` | Explicit persisted-delivery retry |

The last two routes require the independent operator bearer token. That token is never accepted for
provider execution.

Gardener calls the named `GitHubGatewayEntrypoint` Service Binding for health, login initiation,
installation initiation/finalization, repository synchronization, username resolution, capability
discovery, and bounded operation execution. The Gateway calls the named
`GardenerGitHubEntrypoint` binding for login completion and verified event delivery. Neither RPC
entrypoint is an HTTP provider-operation route.

## Provisioning

From a reviewed Gardener checkout:

```bash
pnpm install
pnpm check
pnpm gardener -- setup --workspace my-team --owner owner-login --personal
```

For an organization-owned App:

```bash
pnpm gardener -- setup \
  --workspace my-team \
  --owner owner-login \
  --organization my-organization
```

The equivalent coding-agent flow is documented in
[Set up Gardener with a coding agent](setup-with-coding-agent.md). It runs the same CLI and security
boundary; the human still confirms the exact plan and authorizes GitHub's Manifest form.

Before mutation, `gardener setup` checks the selected account and resource names, prints the exact
identity/resource plan, validates all three generated Worker configurations locally, and asks for an
exact confirmation. It then prints every external command and checkpoints after each completed phase:

1. Resolve the requested human GitHub login to its immutable numeric ID and require exact
   confirmation. The lookup uses no GitHub credential.
2. Verify the selected Cloudflare account has no conflicting deterministic names, record setup
   intent, and create both D1 databases plus the Gardener R2 bucket. A resumed intent adopts only
   those exact names in the same recorded account.
3. Deploy the credential-free Gateway shell and apply its D1 migration.
4. Build/deploy Gardener with `--containers-rollout none`, apply migrations, and seed the permanent
   owner before OAuth credentials exist.
5. Redeploy the Gateway with the reverse named Service Binding.
6. Open GitHub's App Manifest form and exchange the one-use manifest code.
7. Write temporary recovery data with mode `0600`, upload each secret through Wrangler stdin, and
   verify Gateway doctor, Gateway → Gardener RPC, and Gardener → Gateway health.
8. Checkpoint completion, then delete `setup-recovery.json` as an idempotent cleanup step.

V1 derives deterministic Worker, D1, Workflow, R2, and container names from the workspace slug and
uses workers.dev origins. This permits multiple isolated workspace stacks in one Cloudflare account
without adding tenant columns. Custom domains are deferred.

### Local files

The CLI uses:

```text
~/.config/gardener/<workspace>/setup.json
~/.config/gardener/<workspace>/setup-recovery.json
~/.config/gardener/<workspace>/gateway-operator-token
```

The directory is mode `0700`; files are mode `0600`. `setup.json` contains no provider credential.
`setup-recovery.json` exists only while manifest credential upload/verification is incomplete. The
operator token remains local and rotatable. Never copy these files into a repository.

### Resume after failure

Run the same `gardener setup` command. The CLI reads `setup.json`, resumes from the last completed
phase, and reuses `setup-recovery.json` when GitHub already returned credentials. Partial secret
uploads are safe to repeat. Do not delete the recovery file until doctor reports ready.

If the manifest was created but conversion failed before credentials were recorded, delete the
incomplete GitHub App in GitHub and restart the manifest phase. GitHub manifest conversion codes are
single-use.

## Repeatable validation

Validation is deliberately layered because a Wrangler dry run cannot prove live Service Bindings,
GitHub callbacks, or provider mutations.

### Per-change local and CI gate

```bash
pnpm check
pnpm gardener -- gateway plan --workspace qual-local-dry-run
```

`gateway plan` builds Gardener, generates the credential-free shell, Gardener, and linked Gateway
configurations, and runs all three through `wrangler deploy --dry-run`. It never authenticates to
Cloudflare and never creates or changes a remote resource. `pnpm check` runs the same generated
qualification-topology dry run with `qual-ci-dry-run` in addition to unit, contract, type, UI, build,
and checked-in Wrangler gates.

This proves bundling, generated names, D1/R2 declarations, entrypoint names, and both Service Binding
configurations. It does not prove that remote resources exist, circular RPC works on Cloudflare, D1
migrations apply remotely, GitHub accepts the App, or a webhook causes exactly one provider effect.

### Live baseline smoke

After `gateway init` completes:

```bash
pnpm gardener -- gateway smoke --workspace qual-release-123
```

The smoke performs read-only live checks of Gateway public health, authenticated doctor, actual
GitHub App credentials, Gateway → Gardener RPC with workspace identity, Gardener → Gateway RPC,
the exact 29-operation capability response (12 available and 17 unavailable), runtime health, and
failed/stale delivery backlog. It writes an owner-only JSON report under
`~/.config/gardener/<workspace>/reports/`.

This baseline is necessary but not the full provider vertical slice. Before retiring an old stack,
also qualify the following against disposable personal and organization repositories:

1. Owner OAuth succeeds; an invited member succeeds; an uninvited identity is rejected.
2. Personal and organization App ownership both work, and two installations remain attached at once.
3. Repository sync adds, removes, renames, suspends, and restores repositories without widening
   assignments or policy.
4. A real GitHub issue webhook is acknowledged with `202`, persisted, delivered over RPC, and admits
   the expected bounded run.
5. A deliberately unavailable Gardener binding leaves one diagnosed `failed` delivery; restoring the
   binding and running explicit retry delivers the same event without a second run.
6. With policy and one assignment enabled only in the disposable repository, one issue produces one
   Flue run, one exact marked comment, and one hash-bound Gateway receipt.
7. Retrying/redelivering the same event and operation produces no second GitHub comment.
8. End with Gardener globally paused and archive only non-secret IDs, hashes, timestamps, run status,
   receipt status, and the disposable issue URL in the qualification report.

The first iteration keeps these GitHub/browser actions operator-driven rather than introducing a CI
GitHub user token or copying App credentials outside the Gateway. Unit/state-machine tests cover the
same failure and replay cases on every change; the live checklist proves Cloudflare and GitHub
behavior that a local emulator cannot.

### Operator-driven disposable qualification

A complete fresh installer exercise remains operator-driven because GitHub App Manifest approval is
a browser authorization step:

```bash
pnpm gardener -- gateway qualify \
  --workspace qual-release-123 \
  --owner owner-login
```

`qualify` marks the checkpoint as qualification-only, runs real `init`, runs the live baseline smoke,
and then attempts mandatory Cloudflare teardown even when setup or smoke fails. It is intentionally
restricted to `qual-*` names. The command never targets ordinary workspace checkpoints.

For the full provider checklist, run `gateway init --qualification`, perform `gateway smoke` and the
operator-driven GitHub checks, then run guarded `gateway destroy`; the one-command `qualify` path is
only the fresh-installer and baseline-health exercise.

The GitHub App itself must still be deleted from the owning personal or organization settings after
the Cloudflare teardown. Gardener does not retain owner credentials capable of deleting that App.
Do not describe the qualification as fully cleaned up until its installations and App are gone.

### Guarded teardown

Preview the exact resources without any remote reads or mutations:

```bash
pnpm gardener -- gateway destroy --workspace qual-release-123 --dry-run
```

Execute only for an explicitly qualification-marked checkpoint:

```bash
pnpm gardener -- gateway destroy \
  --workspace qual-release-123 \
  --execute \
  --confirm qual-release-123
```

Execution verifies the current Cloudflare account and pinned D1 IDs before deleting. It deletes the
two Workers, two D1 databases, and R2 bucket; removes the local operator token only after successful
remote cleanup; and retains setup, teardown, and smoke reports. If teardown is interrupted, rerun the
same command. A non-empty R2 bucket can block deletion and must be emptied before retry.

## Owner and member identity

GitHub OAuth proves a human identity only. The temporary OAuth token is used once for `GET /user`
and discarded. OAuth grants no repository authority.

The OAuth state is also the random one-use handoff. Only its SHA-256 hash is stored in Gateway D1.
The Gateway sends the immutable numeric subject and login snapshot to Gardener through RPC. Gardener
stores only a hash of the handoff and consumes it once into an opaque local session.

Owner membership is preseeded by numeric subject; there is no first-user-wins path. Invitations also
resolve a typed username to a numeric subject before Gardener stores them. Login matching never
trusts a mutable username.

Sessions store only SHA-256 token hashes and use a 30-minute sliding idle limit plus an eight-hour
absolute limit. Public HTTPS uses `__Host-gardener_session`, `Secure`, `HttpOnly`, and `SameSite=Lax`.

## Installation lifecycle

A current Gardener owner starts installation. Gardener and Gateway persist the initiating user's
immutable subject and a random request/state. GitHub's callback only marks the App installation
ready. The same initiating Gardener owner must then finalize it through a same-origin POST.
Organization account IDs are never compared with human user IDs.

A workspace may attach multiple personal and organization installations. Repository sync obtains
short-lived tokens per installation, writes one fenced generation, and marks repositories missing
from that completed generation inactive. New repositories do not acquire Agent assignments or
policy automatically.

Installation deletion/suspension webhooks narrow live authority immediately. Unsuspension removes
that narrow state; it does not create assignments or widen policy.

## Webhook delivery protocol

For each request the Gateway:

1. bounds the body size;
2. verifies `X-Hub-Signature-256` over the exact bytes;
3. hash-binds the delivery ID, event name, and payload;
4. persists normalized trusted facts (or a terminal ignored record);
5. returns HTTP `202`;
6. schedules one direct Gardener RPC attempt with `waitUntil`.

Deliverable state is fenced:

```text
received -> delivering(attempt token + lease) -> delivered
                                  \-> failed
```

An old attempt can update only its own attempt token. Failures remain in D1; V1 has no Queue or
background retry scheduler. Gardener's provider/delivery uniqueness makes an ambiguous retry safe.

Inspect without exposing payloads or secrets:

```bash
pnpm gardener -- gateway doctor --workspace my-team
```

Retry exactly one delivery:

```bash
pnpm gardener -- gateway retry <github-delivery-id> --workspace my-team
```

## Exact operation protocol

Capability discovery always lists all 29 contract kinds. Exactly these 12 currently have verified
executors:

- `issue.label.add`
- `issue.label.remove`
- `issue.comment.create`
- `issue.comment.update`
- `issue.close`
- `issue.reopen`
- `pull_request.review.submit`
- `pull_request.update`
- `branch.create`
- `commit.create`
- `pull_request.open_draft`
- `pull_request.merge`

The other 17 are advertised unavailable and rejected before an installation token is requested.
For replay safety, pull-request draft-state changes and REST metadata/state changes are separate exact
`pull_request.update` operations rather than one multi-mutation operation. The current Gardener runtime
is narrower still: automatic issue comments only.

`executeOperation` requires a delivered, integrity-checked event; exact repository/installation and
resource bindings; an active synchronized repository; strict operation parsing; and a canonical
operation hash. One operation ID can represent only one run, event, repository, resource, and exact
operation JSON.

Execution receipts use fenced leases and hash-bound terminal records. Ambiguous GitHub outcomes are
reconciled before retry. Exact comments include the host marker:

```html
<!-- gardener-operation:op_abcd1234 -->
```

The marker is part of the canonical body. The Gateway recognizes only effects authored by its own
App. Installation tokens are never returned to Gardener.

## Failure recovery

| Symptom | Action |
|---|---|
| Gateway shell is up, Gardener deploy failed | Rerun `gardener setup`; it resumes at Gardener |
| Manifest credentials obtained, upload failed | Keep recovery file and rerun `gardener setup` |
| `/health` not ready | Check both bindings, all Gateway secrets, and both D1 migrations |
| Webhook is `failed` | Use doctor, fix Gardener, then retry its delivery ID |
| Webhook is stale `delivering` | Explicit retry can reclaim the expired lease |
| Operation is `executing` | Wait for its lease; retrying the same exact ID is safe |
| Installation suspended/deleted | Restore in GitHub, then sync; authority remains narrowed meanwhile |
| Operator token suspected exposed | Generate a new token, upload it as the Gateway secret, replace local file |

## Development deployment

The former shared Connect architecture is not supported. New development and customer workspaces use
`gardener setup`, one dedicated Gateway/App, and the live validation checklist above. Setup never
deletes or replaces an existing workspace. Keep Gardener globally paused until a separate explicit
action enables a repository assignment and runtime.
