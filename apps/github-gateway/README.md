# Gardener GitHub Gateway

A customer-owned, single-workspace GitHub credential and execution boundary.

- Public: health, GitHub OAuth/install callbacks, signed webhooks, authenticated sanitized operator
  doctor/retry.
- Private: named `GitHubGatewayEntrypoint` RPC called by Gardener.
- Reverse private binding: named `GardenerGitHubEntrypoint` RPC for login completion and event delivery.
- Authoritative local state: Gateway D1 migrations in `migrations/`.
- Credentials: only the values listed in `.dev.vars.example`; never add them to Gardener.

Use the repository CLI rather than deploying the two Workers out of order:

```bash
pnpm gardener -- gateway init --workspace my-team --owner owner-login
pnpm gardener -- gateway doctor --workspace my-team
pnpm gardener -- gateway retry <delivery-id> --workspace my-team
```

See [`docs/github-gateway.md`](../../docs/github-gateway.md).
