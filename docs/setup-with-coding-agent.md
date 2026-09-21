# Set up Actions-native Gardener with a coding agent

A coding agent must use the same Gardener CLI as a human. It must not reproduce deployment with ad
hoc Wrangler, Cloudflare API, GitHub API, curl, or SQL commands.

## Preconditions

- trusted Gardener source checkout;
- Node.js 24+ and pnpm 11.25.0;
- authenticated `wrangler` and `gh` sessions;
- a clean customer repository working tree;
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
7. Show only the generated `.gardener/` and `.github/workflows/` paths, resource names, ingress
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

Teardown is dry-run by default and requires the exact workspace confirmation to execute:

```bash
pnpm gardener -- down --workspace my-gardener --source-root "$PWD"
pnpm gardener -- down --workspace my-gardener --source-root "$PWD" \
  --execute --confirm my-gardener
```
