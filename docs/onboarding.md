# Onboarding a repository (internal preview)

Gardener is in preview. Releases are git tags; [the changelog](../packages/cli/CHANGELOG.md) lists what each one
changes. One Gardener installation (a "workspace": one Worker and one D1 database) serves every
repository you connect to it.

## Prerequisites

- Node.js 24+ and pnpm.
- `wrangler login` to the Cloudflare account that runs Gardener (Workers AI is billed there).
- `gh auth login` with admin access to the repositories you connect.
- The organization's Actions policy must allow the reusable workflow `scuffi/gardener`
  (**Organization settings → Actions → General**). Private repositories can call it because it is
  public.

Get the CLI at a release tag:

```bash
git clone https://github.com/scuffi/gardener && cd gardener
git checkout v0.1.13
pnpm install
```

Every command below runs from this checkout and passes `--source-root "$PWD"`.

## Connect a repository

Check out the repository's default branch, then:

```bash
REPO=/path/to/my-repo

# 1. Create .gardener/gardener.json.
pnpm gardener -- init --repository-root "$REPO"

# 2. Pick starter tasks (see below).
mkdir -p "$REPO/.gardener/tasks"
cp -r examples/tasks/triage examples/tasks/pr-review examples/tasks/mention-reply "$REPO/.gardener/tasks/"
```

3. Mention tasks need a handle. Add `"handle": "<name>"` to `$REPO/.gardener/gardener.json`, where
   `<name>` is what people type after `@`. Pick a name that is **not** a real GitHub account
   (`gh api users/<name>` should return 404); otherwise every mention also notifies that person.

   If the repository already has a `.github/workflows/gardener-sync.yml` that Gardener didn't
   generate, add `"syncWorkflow": "gardener-repo-sync.yml"` (any `gardener-*.yml` name) so the
   generated sync workflow uses that file instead. Gardener's own repository needs this, because it
   publishes the reusable workflow at the default path.

4. Deploy, compile, enroll and verify:

```bash
pnpm gardener -- yolo --workspace internal --repository my-org/my-repo \
  --repository-root "$REPO" --source-root "$PWD"
```

5. Commit and push the generated files to the default branch:

```bash
cd "$REPO" && git add .gardener .github/workflows && git commit -m "Add Gardener" && git push
```

Repeat for each repository, using the same `--workspace`.

## Starter tasks

| Task | Runs on | Does |
| --- | --- | --- |
| `triage` | a new issue | Comments with a short summary and likely duplicates, and adds up to two existing labels |
| `pr-review` | a pull request being opened | Leaves one comment-only review (never approves or blocks) |
| `mention-reply` | a comment mentioning the handle | Replies on the thread; "@handle rebase this" rebases the pull request through GitHub |

These are deliberately left out of the starters:

- **Close and merge.** Comment triggers accept the owner, collaborators and organization members.
  In an internal organization that means every employee, so anyone could ask the bot to close or
  merge. Merge is still gated on named checks, but close is not.
- **Code changes (`repository.exec`).** It runs a model-controlled shell in the checkout, with
  network access that Gardener does not yet isolate. `generate` warns about it.

To change a task, edit its `TASK.md`, run `generate`, then commit and push. The generated
**Gardener · Sync tasks** workflow enrolls the change when it reaches the default branch. The task sets its own limits; the only ceiling
is `runtime-seconds: 21000`, which fits a GitHub-hosted job. See [Limits](task-reference.md#limits)
for the format.

## Writing your own task (anyone)

Writing and checking a task needs only Node.js 24+ and the published CLI, with no Cloudflare access:

```bash
cd /path/to/my-repo
mkdir -p .gardener/tasks/my-task   # write .gardener/tasks/my-task/TASK.md
npx @scuffi/gardener@0.1.13 generate
```

`generate` validates every task, then writes the lock file and one workflow per task. Commit them
and open a pull request. If a coding agent writes the task, point it at `.gardener/SKILL.md`:
`init` creates it and `generate` keeps it current, and it covers the task format, every trigger,
tool and effect, and this workflow. When it merges, the **Gardener · Sync tasks** workflow enrolls the task,
with no operator step. Use the same CLI version as the repository's pinned release: if your
generated files don't match what that release produces, the pull request's **Check tasks** check
fails and asks you to regenerate. Merged anyway, the sync fails the same way, and the previous
tasks keep running.

If your npm config sets `min-release-age` (a supply-chain delay), npm refuses versions published
in the last few days. Add `--min-release-age=0` to the `npx` command to use a new release.

## Day to day

All of these take `--workspace internal --source-root "$PWD"`:

| Need | Command |
| --- | --- |
| Stop one task | Delete it, or set `draft: true`, on the default branch |
| Pause a whole repository | `pnpm gardener -- repository disable --repository my-org/my-repo` |
| Resume | `pnpm gardener -- repository enable --repository my-org/my-repo` |
| Recent runs | `pnpm gardener -- runs --repository my-org/my-repo` |
| One run in detail | `pnpm gardener -- runs view --run <run-id>` |
| Check the installation | `pnpm gardener -- doctor --repository my-org/my-repo --repository-root "$REPO"` |

`runs view` includes the audit trail. `tool.called` rows show each tool call the model made, with
its status and a short target (a file path or provider route, never command text), in order.
`proposal.refused` and `tool.failed` rows show what it was refused (a failed call has both a
`tool.called` and a `tool.failed` row), and `task.settled` totals the calls and proposals. A failed run's error in the Actions tab ends with the same totals, such as
`(16 tool calls: 9 repository.read_file, 7 provider.api.read; no effects proposed)`, without the
targets. A run that ends in `budget-exceeded` needs higher limits or narrower instructions.

## Upgrading

When a new tag is released, upgrade every connected repository to it:

```bash
cd gardener && git fetch --tags && git checkout v0.1.13 && pnpm install

pnpm gardener -- upgrade --workspace internal --repository-root "$REPO" --source-root "$PWD"

cd "$REPO" && git add .gardener .github/workflows package.json && git commit -m "Upgrade Gardener to v0.1.13" && git push
```

`upgrade` redeploys the shared Worker, moves the repository's workflows to the release's pinned
commit, and moves any `package.json` script that runs a pinned `@scuffi/gardener` to the release. Deploy first: a sync from a newer release is accepted only once the Worker runs that
release. The repository keeps running on its previous release until the commit reaches the default
branch, where the sync moves it over. Keep every repository on the same tag. The CLI keeps no local
state, so any operator logged in to the Cloudflare account can run it. It refuses to replace a
runtime that a newer release deployed.

## Cutting a release (Gardener maintainers)

1. Land the change on `main` with a changeset: run `pnpm changeset`, pick `@scuffi/gardener` and the
   bump, and write the changelog entry for users. Changes users won't notice need none. If the change
   touches contracts, protocol or runner code, finish its pin chain ("Pin bridge actions", then
   "Pin CLI workflow ref") first.
2. The Release workflow keeps a **Version Packages** pull request open while changesets are pending.
   It bumps `packages/cli/package.json`, adds the dated entry to `packages/cli/CHANGELOG.md`, and
   moves this guide's version pins. Run `node scripts/changeset-version.mjs` locally to preview it,
   then `git checkout .` to undo.
3. Merge the Version Packages pull request. The Release workflow checks that every pinned workflow
   and bridge exists (`pnpm check:release-pins`), stages `@scuffi/gardener@0.1.N` on npm, and tags
   the merge commit `v0.1.N`.
4. Approve the staged release with 2FA: `npm stage list @scuffi/gardener`, then
   `npm stage approve <stage-id>` (or approve it on npmjs.com). Nothing is installable until then.
   Tell users to upgrade.

If a release goes wrong:

- **A check failed before staging** (for example `check:release-pins`): fix it on `main`. The next
  push to `main` tries the release again, because the version is neither tagged nor on npm. To retry
  without a new commit, use **Run workflow** on the Release workflow, on `main`.
- **Staged, but the tag job failed:** use **Re-run failed jobs** on that Release run. It retries only
  the tag. npm refuses to stage the same version twice, so don't re-run the whole workflow.
- **The stage was rejected:** the tag still marks the version as released, so nothing retries it.
  Release the fix as the next version.
