# Security

Gardener is under active Agent-native integration and is not an SLA-backed service. Report vulnerabilities privately to the repository maintainers; do not open a public issue containing exploit details, credentials, private repository content, or customer data.

## Fail-closed release status

The current runtime is operational only for one experimental bounded path: an eligible `github.issue.opened` event may produce one model-only proposal and an automatic-policy `issue.comment.create` exact effect through Connect V2. All tools, workspaces, approval-mode effects, other events/operations, and general orchestration remain unavailable. Do not treat this slice as a complete production Agent runtime; real Cloudflare staging and independent review remain required before broader release.

## Credential invariants

- GitHub App private keys, OAuth secrets, webhook secrets, and installation tokens exist only in managed or self-hosted Connect.
- Connect never returns installation tokens or exposes a raw GitHub proxy.
- Credentials never enter source control, URLs, logs, API payloads, Agent packages, prompts, model context, MCP clients, Computer files, artifacts, or local tools.
- The customer instance token is a high-entropy Worker secret. Connect stores its SHA-256 hash; the token itself is not arbitrary GitHub write authority.
- Dashboard sessions, GitHub App installation, Gardener instance authentication, OAuth MCP tokens, one-run grants, and exact-effect grants are separate credentials and cannot substitute for one another.
- Optional Cloudflare Access credentials are encrypted by Connect with an independent AES-256-GCM key, bound to the instance, and used only for outbound relay. Access never replaces inner authentication.
- Agent workspaces receive exact-SHA snapshots with no credentialed Git remote.

## Agent and authoring invariants

- `AGENT.md` prose describes behavior only. It cannot grant repositories, capabilities, effect kinds, network, credentials, policy modes, or bypasses.
- Unknown fields, actions, capabilities, operations, package paths, or unavailable trusted facts fail closed. Omitted capabilities mean none.
- Exact authored bytes, strict parsed semantics, compiled immutable repository IDs, provenance, hashes, and component versions are preserved.
- Drafts are mutable and paused. Publication creates an immutable paused revision. Activation and enablement are separate owner actions.
- Dashboard prompts, repository content, comments, channel text, model output, tools, and eval graders are untrusted for authorization.
- OAuth MCP requires the existing GitHub-authenticated owner consent, exact audience/client/owner agreement, explicit scopes, CSRF/replay protection, and redaction. It may save paused drafts but cannot publish, activate, enable, approve, alter policy/repositories, or execute effects.

## Runtime authority invariants

Authority is the intersection of admission/pause, trusted event eligibility, the compiled revision capability ceiling, instance policy, authoring authorization, any temporary one-run grant, authenticated interruption decisions, exact-effect approval, and Connect execution checks.

- Planning cannot persistently mutate GitHub. Harness tools can expose observations and isolated workspace actions only.
- Runtime repository expansion, new effect kinds, broader actors, or higher authority requires a new revision.
- Credentials, policy editing, bypass authority, and unrestricted repository access are never runtime-grantable.
- Every interruption is typed, expiry-bound, eligible-responder-bound, nonce-bound, payload-bound, and replay-protected.
- Every effect has a stable operation ID, canonical input hash, persisted intent, policy snapshot, explicit retry class, and persisted receipt.
- Approval authorizes only the reviewed exact payload. Re-fetch and revalidation occur before an approved or automatic mutation.
- Multiple runs/tasks may execute in parallel; optimistic expected-state/SHA preconditions replace a global Agent lock.

## Connect and GitHub invariants

- Webhook HMAC is verified over raw bytes before parsing; delivery IDs are deduplicated.
- `RepositoryEventV2` preserves immutable repository/resource/actor identities and separates event actor from resource author.
- A short-lived grant binds the Gardener instance, signed event, installation, repository, resource, and canonical hashes of exact operations.
- Connect validates a strict operation schema, mints a least-privilege one-repository token internally, re-fetches live state, and invokes only an allowlisted endpoint/body.
- Unknown or not-yet-verified operation kinds return a permanent typed unsupported result. Connect never guesses an endpoint or permission.
- Retries preserve operation identity and payload. App-owned markers/receipts prevent duplicate persistent effects.
- Branch/commit operations are bounded, use the `gardener/` namespace, reject force pushes, and enforce denied paths/file/size limits.
- PR creation is draft-only. Merge binds current head/base, state, draft status, required checks and App identities, allowed method, and branch-protection state.
- The Gardener GitHub App must never be a branch-protection or ruleset bypass actor. GitHub remains the final protection enforcement point.
- Release publication/deletion, merge, code changes, networking, and dependency installation begin disabled.
- Missing App permissions or installation reauthorization fails closed with an actionable health state.

## Computer invariants

Each writable run/task/principal receives a separate Cloudflare Computer Durable Object workspace.

- Workspace IDs derive from immutable instance/run/task/principal identity.
- Hydration paths are normalized and credential-bearing files/configuration are rejected.
- Typed/local Git rejects clone, fetch, pull, push, `ls-remote`, network configuration, and credential helpers.
- Worker shell/JavaScript and Container use denied egress by default. Source scanning is defense in depth, not the network boundary.
- Container defaults to Ask per run. Container permission does not grant network or dependency installation.
- Execution time/source/input/output/artifact/file limits are enforced by trusted code.
- Ambiguous execution is not automatically replayed. Unresolved Container synchronization blocks patch/artifact freezing.
- Handles are disposed; durable leases and a sweeper must release expired workspaces and surface cleanup failure in Inbox.
- Model-facing token-bearing Cloudflare Artifacts access is disabled; host-controlled R2 is the artifact boundary.

Computer and Think are preview-only and Flue is experimental. Adapters are untrusted integration boundaries and must pass conformance and real platform staging. Preview unavailability produces a typed failure, never a broader fallback.

## Data and logs

D1 is authoritative for decisions and receipts. Large content belongs in host-controlled R2 with bounded retention. Product traces are redacted observability projections and are not security audit proof. Secrets and upstream authorization headers must be removed from logs/errors; MCP applies an additional output redaction pass.

The Agent-native production cutover intentionally deletes old automation data without export. Repository selections, instance settings/owner state where applicable, and existing operation-policy modes are retained. Operators must acknowledge and test the destructive reset before production.

## Required production controls

- Use distinct production keys and secrets; rotate Connect signing and GitHub App keys through a planned overlap window.
- Restrict/rate-limit public bootstrap while preserving GitHub callbacks/webhooks.
- Keep `LOCAL_DEV_BYPASS` false.
- Configure only verified minimum GitHub App permissions and obtain installation-owner approval for expansions.
- Verify the App is absent from every branch/ruleset bypass list.
- Keep unrestricted networking, dependency installation, automatic code changes, direct push, and auto-merge disabled.
- If Access is enabled, use one full-host application and a dedicated Connect Service Auth token, never a public path bypass or **Any Access Service Token**.
- Complete migration concurrency, replay/idempotency, OAuth consent, browser security/accessibility, Connect live-state, and real Cloudflare Workflows/Worker Loader/Durable Object/R2/Container tests before release.
