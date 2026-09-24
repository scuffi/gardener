# Dependency policy

Every dependency is pinned to an exact version.

- `pnpm versions:check` compares each pin with the latest npm release. It fails on version ranges,
  on disagreements between workspace packages, and on outdated packages that are not deliberately
  held. It runs as part of `pnpm check`.
- Deliberately held packages are listed with a reason in `scripts/check-versions.mjs`. These are
  the Flue runtime and its model-provider peers, the Cloudflare build and deploy tooling, and pnpm.
  A newer release of one of them is a prompt to re-qualify, not an automatic upgrade.
- Dependabot opens grouped update PRs weekly for npm packages and for the Actions used in
  `.github/workflows`.
- Actions in the reusable workflow are pinned by full commit SHA. The workflow itself is consumed
  by SHA, so changing it means cutting a new release (see [Architecture](architecture.md#releases-and-pinning)).

An upgrade is accepted when `pnpm check` passes and, for runtime-affecting packages, a live run of
the plan/apply workflow succeeds against a deployed Worker.
