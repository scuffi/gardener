# Dependency and platform version policy

Gardener validates versions instead of copying them from predecessor projects.

- Runtime dependencies are pinned to exact versions for reproducible customer deployments.
- `pnpm versions:check` compares every dependency in every workspace manifest with the npm `latest` dist-tag and fails on drift or inconsistent workspace versions.
- The root `check` command runs this validation before typechecking, tests, and builds.
- Dependabot checks the complete pnpm workspace weekly and groups Cloudflare runtime updates.
- Before adopting a preview Cloudflare product, verify both the current upstream documentation and npm release, pin the tested version, document its preview status, and add a smoke test against the deployed binding.

CI follows the current Node.js 24 LTS line (24.20.0 when validated); local development supports Node 22 or newer.

Validated while creating the first iteration:

| Package/product | Current npm release | Decision |
| --- | ---: | --- |
| Wrangler | 4.128.0 | Pinned and used |
| Workers types | 5.20260902.1 | Pinned and used |
| Hono | 4.13.5 | Pinned and used |
| jose | 6.2.10 | Pinned and used |
| Zod | 4.5.4 | Pinned and used |
| TypeScript | 7.0.2 | Pinned and used |
| Vitest | 4.1.11 | Pinned and used |
| Workers AI Llama 3.3 70B FP8 Fast | hosted model | Current model page verified; 24k context, JSON Schema output, $0.29/M input and $2.25/M output |
| Cloudflare Agents SDK (`agents`) | 0.22.0 | Evaluated; its Durable Object lifecycle is not needed for the first Queue-backed issue slice |
| `@cloudflare/computer` | 0.2.1 | Preview, explicitly not production-suitable upstream, and requires a SQLite Durable Object plus execution backend; deferred with code-change features |
| `@cloudflare/sandbox` | stable/latest 0.12.9; next 0.13.0-next.751.1 | The documented 1.0 line is still preview and adds Containers/Paid-plan requirements; both lines are deferred |

“Latest” is not sufficient by itself for preview integrations: the version must also pass this repository's typecheck, unit suite, dry-run Worker builds, and an integration smoke test before release.
