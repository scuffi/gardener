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
| Cloudflare Think | `@cloudflare/think@0.17.0` | Preview-only. Behind the Gardener harness contract. |
| Flue runtime/Vite/CLI | `2.0.3` | Experimental. Default harness selection, but replaceable and conformance-tested. |
| Cloudflare Agents SDK | `agents@0.22.0` | Used for the direct generic harness and stateless MCP helpers. |
| Workers OAuth provider | `@cloudflare/workers-oauth-provider@0.10.3` | OAuth boundary; requires audience/client/owner/scope and consent validation. |
| MCP server | `@modelcontextprotocol/server@2.0.0` | Stateless authoring protocol only. |
| AI SDK | `ai@7.0.94` | Framework implementation dependency, not a public Gardener harness. |
| Workers AI provider | `workers-ai-provider@4.0.0` | Framework adapter dependency; no provider secret is required for the standard AI binding path. |
| Wrangler | `4.129.0` | Build/deploy tool. |
| Workers types | `5.20260904.1` | Worker platform types. |
| TypeScript | `7.0.2` | Compiler. |
| Vitest | `5.0.0` | Test runner. |

Flue, Think, and Computer are not promoted to trusted policy or authorization components. Gardener validates requests/results before and after every adapter boundary. A preview adapter being unavailable must produce a typed failure, not a fallback with broader authority.

## Required validation by subsystem

- **Contracts/compiler:** malformed, unknown, oversized, duplicate, traversal, canonical-byte, hash, repository-resolution, capability, eligibility, and semantic-diff tests.
- **D1/Workflows:** fresh install, destructive upgrade, concurrent initialization, immutable revision, idempotency, replay, wait/expiry, cancellation, and child-join tests.
- **Computer:** workerd tests for filesystem/Git/shell/JavaScript; Docker/Cloudflare tests for Container sync, denied egress, cleanup, and ambiguous execution.
- **Harnesses:** one conformance suite across all adapters plus deployed AI binding/Gateway model tests.
- **MCP/OAuth:** dynamic client, owner consent, PKCE/provider behavior, exact audience, scopes, replay, CSRF, redaction, and negative-authority tests.
- **Connect:** real GitHub webhook fixtures, permission checks, exact operation hashes, stale-state conflicts, retry receipts, and unsupported-operation behavior.

CI evidence cannot substitute for Cloudflare staging where Workflows, Dynamic Workers, Worker Loader, Containers, Durable Objects, and R2 differ from local execution.
