# Onboarding a repository (internal preview)

Gardener is in preview. Releases are git tags; [CHANGELOG.md](../CHANGELOG.md) lists what each one
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
git checkout v0.1.0
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

To change a task, edit its `TASK.md` and rerun the `yolo` command above, which recompiles and
re-enrolls it, then commit and push. Limits can go up to `runtime-seconds: 480` and
`input-tokens: 128000`. See [task-authoring.md](task-authoring.md) for the format.

## Day to day

All of these take `--workspace internal --source-root "$PWD"`:

| Need | Command |
| --- | --- |
| Pause one task now | `pnpm gardener -- task disable --repository my-org/my-repo --task triage` |
| Pause a whole repository | `pnpm gardener -- repository disable --repository my-org/my-repo` |
| Resume | the same with `enable`; `task enable` also needs `--repository-root "$REPO"` |
| Recent runs | `pnpm gardener -- runs --repository my-org/my-repo` |
| One run in detail | `pnpm gardener -- runs view --run <run-id>` |
| Check the installation | `pnpm gardener -- doctor --repository my-org/my-repo --repository-root "$REPO"` |

`runs view` includes the audit trail. `proposal.refused` and `tool.failed` rows show what the model
was refused. A run that ends in `budget-exceeded` needs higher limits or narrower instructions.

## Upgrading

When a new tag is released, upgrade every connected repository to it:

```bash
cd gardener && git fetch --tags && git checkout v0.1.1 && pnpm install

pnpm gardener -- upgrade --workspace internal --repository my-org/my-repo \
  --repository-root "$REPO" --source-root "$PWD"

cd "$REPO" && git add .gardener .github/workflows && git commit -m "Upgrade Gardener to v0.1.1" && git push
```

`upgrade` redeploys the shared Worker, moves the repository's workflows to the release's pinned
commit, and re-enrolls its tasks. Keep every repository on the same tag.

## Cutting a release (Gardener maintainers)

1. Land the change on `main`. If it touches contracts, protocol or runner code, finish its pin chain
   ("Pin bridge actions", then "Pin CLI workflow ref") first.
2. Add a section to `CHANGELOG.md` and commit it.
3. `git tag v0.1.N && git push origin v0.1.N`, then tell users to upgrade.
