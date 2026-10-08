# Collaborator guide

This guide is for approved collaborators with pull request access. Public contribution paths are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Setup

You need Node.js 24 or later and pnpm (the version in `package.json`'s `packageManager`; Corepack
picks it up). From the repository root:

```bash
git clone https://github.com/scuffi/gardener.git
cd gardener
pnpm install
```

Install from the root only. The repository is a pnpm workspace.

## Layout

| Path | Contents |
| --- | --- |
| `apps/gardener` | Cloudflare Worker runtime: sessions, task runtime, D1 |
| `packages/cli` | `@scuffi/gardener`: the CLI and task compiler |
| `packages/runner` | GitHub bridge source, built into `bridges/github/*/dist` |
| `packages/contracts` | Task, event and operation schemas |
| `packages/protocol` | Cap'n Web session protocol |
| `bridges/github` | The bridge actions the reusable workflows call, with their committed bundles |
| `.github/workflows/gardener-{task,sync,check}.yml` | The published reusable workflows every repository calls |
| `docs` | User documentation |

[`docs/architecture.md`](docs/architecture.md) explains how the pieces fit, and
[`SECURITY.md`](SECURITY.md) the trust boundaries. Changes that touch the planning and apply split,
tokens, permissions or what a task may do need the most care.

## Checks

```bash
git add -A
pnpm check
```

`pnpm check` runs the version checks, typecheck, every test suite, every build, the CLI package and
bridge bundle checks, and a deploy dry run. It must pass before you push. Stage your changes first:
some checks compare generated files against git.

Run one package's tests with `pnpm --filter <package> test`, and one file with
`pnpm --filter <package> exec vitest run <file>`.

New behaviour needs a test. A bug fix needs a test that failed before the fix.

### Generated files

Some files are generated and committed. Regenerate them rather than editing them:

- **Bridge bundles** (`bridges/github/*/dist`): `pnpm build` rewrites them, and `pnpm check` fails
  if the committed bundle differs from its source.
- **Reference docs** (`docs/task-reference.md` and `docs/cli.md`): tables between
  `<!-- generated:… -->` markers come from the code. Regenerate them with
  `UPDATE_DOCS=1 pnpm --filter @scuffi/gardener exec vitest run test/docs.test.ts`.

### Release pins

Repositories call the reusable workflows at a commit, and those workflows call the bridge actions at
a commit. A change to a bridge bundle or to a reusable workflow therefore lands as three commits:

1. the change itself;
2. `Pin bridge actions`: point the `uses:` lines in `gardener-{task,sync,check}.yml` at commit 1;
3. `Pin CLI workflow ref`: point `DEFAULT_WORKFLOW_REF` in `packages/cli/src/project.ts` at
   commit 2.

`node scripts/check-release-pins.mjs` then checks that every pin resolves and that each layer
accepts the inputs the layer above passes. GitHub rejects every run of a caller that passes an input
its workflow does not define, so a new reusable-workflow input also needs a fixed list of the older
releases that lack it (see `TASK_WORKFLOWS_WITHOUT_REACTIONS` in `packages/cli/src/project.ts`).
`generate` leaves the input out for projects still pinned to one of them.

## Commits

Write a one-line subject in the imperative, describing the change for someone reading `git log`
later: `Pass database writes to Wrangler in a file`, not `fix d1`. Keep each commit to one logical
change, and put dependency bumps in their own commits.

## Pull requests

Describe the problem, the change and how you verified it. Link the issue if there is one. Behaviour
that runs in GitHub Actions is best verified on a test repository before it reaches a live one.

Pull requests from people who are not collaborators are closed automatically. To accept one a
maintainer asked for, add the `allow-pr` label and reopen it.

## Releases

Releases use [changesets](https://github.com/changesets/changesets). A change users will notice
needs one:

```bash
pnpm changeset
```

Pick the bump and write a one-line summary for the changelog. Changes to tests, CI or docs alone need
none.

After merge, the release workflow keeps a **Version Packages** pull request up to date. Merging it
stages `@scuffi/gardener` on npm, where a maintainer approves the publish, and tags the release
`vX.Y.Z`.

## What not to commit

- `node_modules/`, build output other than the bridge bundles, and `.tmp/`.
- `.dev.vars` and any other local secrets.
- Editor and operating system files. Add those to your global gitignore.
