# Gardener architecture

## System purpose

Gardener is a customer-owned repository stewardship runtime. Human owners define portable Agents,
exact repository assignments, and policy. Untrusted model output may propose work; trusted Gardener
code decides whether to construct an exact provider operation. D1 remains authoritative throughout.

The architecture deliberately separates only the boundary that protects source-provider secrets.
Gardener's control plane and runtime remain one Worker. The GitHub Gateway is a second Worker because
Agent/runtime code must never have access to GitHub credentials.

## Deployment topology

One deployed stack is one team workspace:

```text
Customer Cloudflare account
├── Gardener Worker
│   ├── Gardener D1
│   ├── Workers AI
│   ├── Flue Agent Durable Object
│   ├── one-minute D1/Cron reconciliation
│   ├── Computer Durable Object / container (future bounded use)
│   └── R2 workspace inputs
└── GitHub Gateway Worker
    └── Gateway D1

Customer GitHub account or organization
└── Dedicated GitHub App with one or more installations
```

No `workspaces` table exists. Multiple workspace stacks may coexist in one Cloudflare account because
the CLI derives distinct resource names; each stack still has independent Workers, databases, App,
secrets, and Service Bindings.

### Network paths

```text
Browser ─HTTP─> Gardener ─RPC─> GitHubGatewayEntrypoint ─HTTPS─> GitHub
GitHub ─webhook─> Gateway ─D1─> waitUntil ─RPC─> GardenerGitHubEntrypoint
Gardener runtime ─RPC executeOperation─> Gateway ─HTTPS─> GitHub
```

The Gateway's provider execution has no public HTTP route. Gardener and Gateway use named
`WorkerEntrypoint` RPC interfaces defined in `@gardener/provider-github`.

## Data ownership

### Gardener D1 owns product truth

- provider-neutral users and external identities;
- exactly one permanent owner plus member memberships and invitations;
- opaque browser sessions;
- immutable Agent revisions and one active-revision pointer per Agent;
- exact repository assignments and overlap confirmations;
- workspace and repository policy;
- normalized event admission records;
- immutable run snapshots, product status/output, and historical/future task records;
- Flue dispatch convergence, cancellation intent, effect receipts, Inbox, decisions, usage, and audit.

### Gateway D1 owns provider-bound truth

Six concerns are represented without tenant columns:

- `oauth_flows`: hashed one-use OAuth state and identity snapshot;
- `installation_flows`: hashed GitHub state and owner-bound request correlation;
- `installations`: active/suspended/revoked personal or organization installations;
- `repositories`: fenced synchronization generations per installation;
- `webhook_deliveries`: exact body hash, normalized event hash, and delivery lease state;
- `operation_receipts`: exact operation binding, execution lease, and hash-bound receipt.

Username-resolution counters are local installation metadata, not product identity state.

### GitHub owns provider authority

GitHub owns App installation consent, installation repository selection, account ownership, branch
protection, issue/PR state, and provider objects. A GitHub username is not an identity key; the
numeric subject is.

## Identity protocol

1. The browser asks Gardener to start login.
2. Gardener calls `beginLogin()` over the private Gateway binding.
3. The Gateway generates random OAuth state and stores only its SHA-256 hash.
4. GitHub redirects to the public Gateway callback.
5. The Gateway exchanges the code, calls `/user`, discards the OAuth token, and calls Gardener's
   private `completeLogin()` with the immutable subject, login snapshot, and one-use handoff.
6. Gardener admits only a preseeded owner or invited numeric subject and stores only the handoff hash.
7. The browser follows a no-referrer redirect to Gardener and consumes the handoff once.
8. Gardener creates an opaque local session and stores only the session token hash.

Membership—not OAuth—authorizes the dashboard. Repository authority—not OAuth—comes from App
installations. MCP tokens are separate principals and are revalidated against active owner
membership for every request.

## Installation protocol

1. A current owner creates a Gardener installation request.
2. Gardener calls the Gateway with the request ID and immutable initiating subject.
3. The Gateway stores a random state hash and redirects to the dedicated App's installation page.
4. GitHub's callback identifies an installation belonging to that App and marks the flow ready.
5. The browser returns to Gardener with a non-secret request correlation ID.
6. The same authenticated initiating owner performs a same-origin finalization POST.
7. Gardener fences that request as `finalizing`; the Gateway verifies the subject, persists the
   installation, and synchronizes its repositories under a per-installation lease.
8. Gardener stores provider-neutral repository snapshots. Assignments and policy remain separate.

This protocol never asks whether an organization account ID equals a human user ID. Several personal
and organization installations may be attached to one workspace.

## Webhook protocol

The Gateway verifies the HMAC over bounded exact bytes before JSON parsing. It binds delivery ID,
event name, and body hash, applies installation lifecycle narrowing, and stores either a strict
`RepositoryEventV2` plus canonical hash or a terminal ignored record.

Acknowledgement and delivery are intentionally separate:

```text
HTTP request
  verify -> durable insert -> HTTP 202
                         └-> waitUntil(one Gardener RPC attempt)
```

Deliverable state is:

```text
received -> delivering(attempt token, lease) -> delivered
                                      └-------> failed
```

A duplicate GitHub request re-drives a persisted `received` delivery, closing the crash window
between D1 insertion and `waitUntil`. Attempt-token predicates prevent an older completion from
overwriting a newer retry. V1 has no Queue and no autonomous retry scheduler. Operators diagnose and
explicitly retry failed/stale deliveries.

Gardener verifies the canonical event hash and workspace ID again. Its provider/delivery uniqueness
admits one event record, and its admission lease makes an ambiguous Gateway retry safe. Every matching
enabled Agent may independently produce a run.

## Agent authority

`AGENT.md` is repository-independent. It describes behavior, triggers, requested observation/effect
capabilities, limits, and eligibility. It cannot name credentials or grant itself authority.

Authority layers only narrow:

```text
workspace ceiling
∩ repository policy
∩ Agent requested effect ceiling
∩ assignment ceiling
∩ provider permission and live repository state
∩ current pause/live-state checks
```

Missing or incomplete repository policy means disabled. New assignments are disabled. “All current”
materializes exact current IDs and does not follow later repositories. Global activation selects one
immutable Agent revision; assignment enablement is the runtime gate.

All matching Agents run independently. Overlap analysis is advisory: enabled Agents that share a
trigger and persistent-effect capability require an exact fresh canonical fingerprint, but intentional
overlap remains allowed.

Run identity is event + Agent + revision. Assignment and policy versions/hashes are immutable run
bindings but do not alter idempotency identity. Later live-state narrowing applies immediately;
later widening never upgrades the frozen snapshot.

## Runtime boundary

The implemented runtime is deliberately bounded:

```text
github.issue.opened
  -> atomic D1 admission of native run + exact request + outbox
  -> deterministic keyed Flue dispatch
  -> one native model turn -> submit_gardener_output_v1
  -> canonical D1 output and exact issue.comment.create
  -> fresh live authority -> Gateway executeOperation
  -> hash-bound receipt -> Flue settlement
  -> bounded D1/Cron convergence for abnormal gaps
```

Flue is the Agent runtime. One static generic Flue Agent receives immutable Agent behavior as data
and owns its conversation, accepted submission, turn, durable tool steps, recovery, and abort. Its
static recovery ceiling is explicit at three attempts/15 minutes; the qualified profile permits one
durable model turn and freezes model/tool/token/deadline limits in the immutable request. The provider
rejects a second turn once the durable context contains an assistant/tool result.

D1 owns product truth: admission, frozen authority/model/profile/request protocol, canonical output, cancellation intent, exact
effect/receipt, terminal status, Inbox, and audit. It does not mirror native Flue turns or tool steps.
`harness_requests` and `harness_submissions` retain the immutable request and accepted receipt. One
small outbox carries only dispatch/reconciliation state.

`submit_gardener_output_v1` is a host-owned durable terminal protocol. The model supplies only an
abstention or bounded proposal; host code derives every repository/event/operation identifier. The
tool retries only the same frozen operation under versioned durable attempt names and re-reads live
authority before every real Gateway call. Effect creation and the `approved`→`executing` claim are
conditional on the native run remaining active and uncancelled. One product singleton fence permits only one terminal call
to enter effect work. Terminal host/validation failures return a sanitized terminating result rather
than a model-visible retryable tool error. Every abandoned exact effect becomes non-active: known pre-provider cancellation/authority/deadline
failures are explicit, while any possibly applied Gateway call becomes an unknown-outcome error and
Inbox item. Durable-step catch, Agent finish, and completed/abnormal/cancelled settlement repair
nonterminal effects before run terminalization. Missing terminal output fails without an extra model turn.

Ordinary Agent runs use no Cloudflare Workflow. A one-minute Cron repairs undispatched rows, lost
accepted receipts, failed/aborted settlements, and cancellation convergence without running a model
or constructing an effect. New runs pin `flue-native-v1`; historical `workflow-v1` rows remain
readable and cannot resume natively. Adapter and durable-tool identifiers require pause/drain or a
retained compatibility implementation before change. Because admission atomically inserts run,
request, and outbox, a missing request or outbox is reported as corruption and is never reconstructed.

Approval-mode execution, human-input interruptions/resumption, general observation/workspace tools,
multi-effect loops, and Computer fix/PR flows are not currently qualified and remain fail closed.

## Exact provider operations

The contracts retain 29 operation kinds. The Gateway advertises exactly 12 verified executors and 17
unavailable kinds. Gardener's live automatic runtime uses only `issue.comment.create`.

`executeOperation` validates, in order:

1. strict typed request and available kind;
2. a delivered, canonical-hash-verified event;
3. exact event/repository/installation/resource facts;
4. active synchronized repository and installation;
5. canonical operation hash and stable operation-ID reuse binding;
6. provider preconditions immediately before mutation;
7. fenced receipt claim and bounded attempt count;
8. provider reconciliation for ambiguous outcomes;
9. hash-bound terminal receipt.

Installation tokens are minted only after unsupported requests and local binding failures are
rejected. Tokens are repository/permission narrowed when possible and never leave the Gateway.
Comments, reviews, commits, and draft PRs use App-authored markers for reconciliation. The exact
comment marker is part of the canonical body.

## Control-plane authorization

Gardener roles are `owner` and `member`. Members may view, draft, simulate, propose, and narrow.
Owners alone invite/remove members, connect installations, create/widen authority, activate Agents,
and perform destructive control-plane actions. The permanent owner cannot be transferred or removed
in V1.

Dashboard writes require a dashboard/local-development principal and same-origin request. MCP remains
stateless and draft/read/validate/simulate only; it cannot reach dashboard-only authority. Local bypass
must remain false on public deployments.

## Deployment and upgrades

Circular bindings require ordered deployment:

1. Gateway shell without reverse binding;
2. Gardener with outbound Gateway binding;
3. linked Gateway with reverse Gardener binding;
4. GitHub App Manifest creation and direct secret upload.

`packages/cli` checkpoints each phase and derives workspace-specific Cloudflare resource names.
Manifest credentials live temporarily in an owner-only recovery file and are deleted only after
health and operator doctor verification. Workers.dev origins are V1; custom domains are deferred.

D1 migrations are ordered and applied by the platform. The v7 pre-V1 cutover intentionally deletes
old Agent/run/runtime evidence while preserving repositories, settings, global policy, and owner/team
data. Additive schema 8 introduces immutable runtime/model/result/cancellation/terminal-fence fields
plus the Flue convergence outbox. Cutover must run paused with no non-terminal `workflow-v1` runs;
`scripts/flue-native-cutover-preflight.mjs` enforces and records that gate. Do not describe
D1 as providing arbitrary read-decide-write transactions; authority and reconciliation use hashes,
versions, claim tokens, leases, and conditional writes.

Unchanged Computer deployments use `--containers-rollout none`. No production deployment, migration,
redelivery, or App permission change occurs without explicit approval. Qualification ends paused.

## Failure ownership

| Failure | Authoritative evidence | Recovery owner |
|---|---|---|
| OAuth rejected/expired | Gateway hashed flow | Human starts a new login |
| Installation ready, finalize failed | Both flow/request rows | Same owner retries finalization |
| Repository sync interrupted | Gateway installation lease/generation | Owner syncs after lease expiry |
| Webhook delivery failed | Gateway delivery row | Operator doctor + explicit retry |
| Gardener event admission interrupted | Gardener event/admission lease | Duplicate Gateway delivery re-drives |
| Model/tool execution interrupted | Flue canonical state + Gardener product projection | Flue recovery, then D1/Cron settlement |
| Provider outcome ambiguous | Gateway operation row + marker reconciliation | Replay exact operation ID |
| Binding/secret mismatch | both health RPCs and `/health` | Resume CLI/deploy ordering |

See [Gateway operations](github-gateway.md), [Security](../SECURITY.md), and
[Foundation status](foundation-status.md).
