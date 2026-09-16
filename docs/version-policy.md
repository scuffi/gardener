# Dependency and platform version policy

Gardener pins runtime and build dependencies exactly. Preview frameworks are isolated behind Gardener-owned contracts rather than becoming product authority boundaries.

- `pnpm versions:check` compares workspace manifests with the npm `latest` dist-tag and rejects inconsistent workspace versions.
- The root `check` command runs version checks, typechecks, tests, builds, and a deployment dry run.
- Dependabot scans the pnpm workspace weekly.
- A version bump is not accepted solely because it is latest. It must pass the contract/compiler suites, adapter conformance, Worker dry run, and the relevant deployed Cloudflare smoke tests.
- Never automatically upgrade an in-flight run. `AgentRunSnapshotV1` pins compiler, runtime, capability catalog, model harness ID, and adapter version.

Current exact versions relevant to the Agent-native foundation include:

| Package/product | Pinned version | Status and boundary |
| --- | ---: | --- |
| Cloudflare Computer | `@cloudflare/computer@0.2.1` | Preview-only. Behind `ExecutionWorkspace`; requires SQLite Durable Objects, Worker Loader experimental support, R2, and optional Container staging. |
| Flue runtime/Vite/CLI | `2.0.3` | Experimental. Gardener's only Agent runtime; native runs pin product adapter `gardener-flue-native/v1` separately. |
| Cloudflare Agents SDK | `agents@0.22.0` | Used only for stateless MCP helpers, not Agent execution. |
| Workers OAuth provider | `@cloudflare/workers-oauth-provider@0.10.3` | OAuth boundary; requires audience/client/owner/scope and consent validation. |
| MCP server | `@modelcontextprotocol/server@2.0.0` | Stateless authoring protocol only. |
| Workers AI provider | `workers-ai-provider@4.0.0` | Framework adapter dependency; no provider secret is required for the standard AI binding path. |
| Wrangler | `4.129.0` | Build/deploy tool. |
| Workers types | `5.20260904.1` | Worker platform types. |
| TypeScript | `7.0.2` | Compiler. |
| Vitest | `5.0.0` | Test runner. |

Flue and Computer are not promoted to trusted policy or authorization components. Gardener validates requests/results before and after the Flue boundary. Flue being unavailable must produce a typed failure; there is no fallback runtime with broader authority.

## Required validation by subsystem

- **Contracts/compiler:** malformed, unknown, oversized, duplicate, traversal, canonical-byte, hash, repository-resolution, capability, eligibility, and semantic-diff tests.
- **D1/Flue reconciliation:** fresh install, destructive/additive upgrade, immutable driver/result, outbox fencing, keyed replay, abnormal settlement, cancellation, and expiry tests.
- **Computer:** workerd tests for filesystem/Git/shell/JavaScript; Docker/Cloudflare tests for Container sync, denied egress, cleanup, and ambiguous execution.
- **Flue runtime:** direct driver, tool-preserving bounded provider, terminal protocol, exact-effect replay, and deployed Durable Object/AI binding tests.
- **MCP/OAuth:** dynamic client, owner consent, PKCE/provider behavior, exact audience, scopes, replay, CSRF, redaction, and negative-authority tests.
- **GitHub Gateway:** real webhook fixtures, permission checks, Service Binding contracts, exact operation hashes, stale-state conflicts, retry receipts, and unavailable-operation behavior.

CI evidence cannot substitute for Cloudflare staging where Cron, Dynamic Workers, Worker Loader, Containers, Durable Objects, and R2 differ from local execution.
