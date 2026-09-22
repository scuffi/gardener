# Set up Actions-native Gardener with a coding agent

A coding agent must use the same Gardener CLI as a human. It must not reproduce deployment with ad
hoc Wrangler, Cloudflare API, GitHub API, curl, or SQL commands.

## Preconditions

- trusted Gardener source checkout;
- Node.js 24+ and pnpm 11.25.0;
- authenticated `wrangler` and `gh` sessions;
- a clean customer repository working tree;
- while `scuffi/gardener` is private, a private customer/demo repository owned by `scuffi` and the Gardener repository Actions access setting enabled for repositories owned by that user;
- when account-wide Access protects all `workers.dev` hostnames, a local
  `CLOUDFLARE_API_TOKEN` scoped to Access Apps and Policies Edit.

The agent must never print, read back, persist, or place that token into model context, repository
files, command arguments, logs, D1, Workers, or GitHub.

## Copyable prompt

```text
Set up Actions-native Gardener in this repository using only the reviewed Gardener CLI.

1. Confirm `gh auth status` and `wrangler whoami` without displaying credentials.
2. Ask me for a short lowercase workspace name.
3. Resolve this repository's owner/name with `gh`.
4. Run `gardener up --workspace <workspace> --repository <owner/name> --demos`, passing the
   customer repository and trusted Gardener source roots explicitly when they differ.
5. Do not recreate any CLI step with direct API, Wrangler, SQL, or file-generation commands.
6. If setup stops, rerun the identical command so the private deployment intent or installation
   manifest can resume it.
7. Show only the generated `.gardener/` and `.github/workflows/` paths, resource names, runtime
   origin, bundle hashes, and doctor result. Never show credentials.
8. Do not commit or push. Ask me to review and commit the generated files.
```

## Direct human equivalent

From the trusted Gardener checkout:

```bash
pnpm gardener -- up \
  --workspace my-gardener \
  --repository my-org/my-repository \
  --repository-root /path/to/customer-repository \
  --source-root "$PWD" \
  --demos
```

For a standalone tarball, run the packaged binary without a Gardener source checkout:

```bash
npx --yes --package=./gardener-cli-demo-0.1.0.tgz gardener up \
  --workspace my-gardener \
  --repository owner/repository \
  --demos
```

The tarball contains the single Actions-only runtime Worker, GitHub bridge compiler defaults, and
one Actions-only D1 baseline migration. If account-wide Cloudflare Access intercepts new
`workers.dev` hostnames, set a scoped `CLOUDFLARE_API_TOKEN` with Access Apps and Policies edit
permission so Gardener can create the exact-host runtime bypass.

Then review and commit in the customer repository:

```bash
git add .gardener .github/workflows
git commit -m "Add Gardener"
git push
```

Open an issue labeled `gardener-bug` or `gardener-docs` to exercise the corresponding bounded task.

## Recovery and teardown

Installation state is owner-only under:

```text
~/.config/gardener/<workspace>/actions/
```

Rerun `gardener up` after interruption. Do not manually rewrite deployment intent, generated
Wrangler configuration, or installation manifests.

Inspect health and operational state with:

```bash
pnpm gardener -- doctor --workspace my-gardener --source-root "$PWD"
pnpm gardener -- repositories --workspace my-gardener --source-root "$PWD"
pnpm gardener -- tasks --workspace my-gardener --source-root "$PWD"
pnpm gardener -- runs --workspace my-gardener --source-root "$PWD"
```

Use `repository enable|disable` and `task enable|disable` as admission kill switches. Repository disable also blocks effects authentication; task disable stops new plans but does not revoke an effect already planned before the toggle. `connect` preserves disabled state and never revives retired bundle hashes. `gardener qualify --drills`
checks negative admission, force cancellation, and settlement/effect audit cardinality.

Upgrade records an immutable source digest. Code rollback requires an explicit trusted prior source
checkout and a digest already present in deployment history; database migrations remain forward-only.
The Actions-only cutover starts deployment-hash version `actions-v2` and intentionally discards
pre-cutover rollback digests because their legacy migration inputs are not part of the shipped package:

```bash
pnpm gardener -- upgrade --workspace my-gardener --repository my-org/my-repository \
  --repository-root /path/to/customer-repository --source-root "$PWD"
pnpm gardener -- rollback --workspace my-gardener \
  --source-root /trusted/prior/gardener --confirm <historical-source-digest>
```

Teardown is a two-step, manifest-bound operation. The planning invocation returns a 24-hour intent
digest; review it, then pass that exact digest to a separate execution invocation:

```bash
pnpm gardener -- down --workspace my-gardener --source-root "$PWD"
pnpm gardener -- down --workspace my-gardener --source-root "$PWD" \
  --execute --confirm <intent-digest>
```
