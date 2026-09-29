# Operations

All commands run from a Gardener source checkout as `pnpm gardener -- <command>`. Most commands
take these three flags:

| Flag | Meaning |
| --- | --- |
| `--workspace <name>` | Names the installation. Its Worker and D1 database are both `gardener-<workspace>`. |
| `--repository-root <path>` | Points at the customer repository. It defaults to the current directory. |
| `--source-root <path>` | Points at the trusted Gardener checkout used to build and deploy the Worker. |

`gardener <command> --help` lists every option.

## Prerequisites

- Node.js 24+ and pnpm 11.25.
- `wrangler login` and `gh auth login` completed for the target accounts.
- The customer repository's Actions policy must allow `scuffi/gardener`'s actions and reusable
  workflow. The default policy allows all actions. If the repository or its organization allows
  only selected actions, add the ones under `scuffi/gardener` to the allowed list.
- If any task opens pull requests or approves reviews, turn on **Allow GitHub Actions to create and
  approve pull requests** in the customer repository's **Settings → Actions → General → Workflow
  permissions**. It is off by default for new repositories. Without it, apply stops at the
  pull-request step with `GitHub Actions is not permitted to create or approve pull requests`,
  and rerunning the failed job after enabling it resumes from that step. `doctor`, which `yolo` and
  `upgrade` also run, warns when the setting is off. Leave the default workflow
  permissions at read-only: each generated workflow requests exactly the permissions its task needs.
- If any task sets a non-Cloudflare `model:` (for example `openai/…` or `anthropic/…`), add that
  provider's key, or turn on Unified Billing, on the Cloudflare account's AI Gateway named
  `default` (**AI → AI Gateway**). Gardener stores no provider keys. Without them, runs of that
  task fail at the first model call. `@cf/…` models need nothing extra.

## Install

```bash
pnpm gardener -- yolo \
  --workspace my-gardener \
  --repository my-org/my-repo \
  --repository-root /path/to/my-repo \
  --source-root "$PWD" \
  --demos
```

`yolo` runs `init`, `generate`, `deploy`, `connect`, and `doctor` in order. Each step can also be run on
its own:

| Command | Effect | Remote changes |
| --- | --- | --- |
| `init [--demos]` | Creates `.gardener/`, optionally with the two demo tasks | None |
| `generate` | Compiles tasks, writes the lock file and one workflow per task | None |
| `deploy` | Creates or adopts the D1 database, applies migrations, deploys the Worker, records installation facts, checks `/health` | Cloudflare |
| `connect` | Enrolls the repository and its bundle hashes, sets `GARDENER_RUNTIME_URL`, and starts the sync workflow on the default branch if it is there yet. Needed once per repository | D1, GitHub variable, one workflow run |
| `doctor` | Verifies the installation. Warns about enrollments whose workflow pin differs from this CLI, and repositories whose tasks open or approve pull requests without the setting below | None |

`init` and `generate` never overwrite existing task files or workflows that Gardener did not generate.
Rebuilding unchanged tasks produces byte-identical output. No command commits or pushes, so review
the generated files and commit them yourself.

The CLI keeps no local state. Every command finds the installation on the Cloudflare account that
`wrangler` is logged in to (set `CLOUDFLARE_ACCOUNT_ID` if it can see several) by the
`gardener-<workspace>` name. `deploy` records the runtime URL, CLI version and deployment digest in
the workspace's own D1, so any operator with access to the account can run any command. `deploy`
adopts existing `gardener-<workspace>` resources, and refuses to replace a runtime that a newer CLI
deployed. If a command is interrupted, rerun it unchanged.

### Cloudflare Access

Some accounts have an Access policy covering every `workers.dev` hostname. In that case, GitHub
runners cannot reach the Worker. `deploy` detects this and stops. Provide a token scoped to
**Access: Apps and Policies — Edit** and rerun:

```bash
export CLOUDFLARE_API_TOKEN=...
pnpm gardener -- deploy --workspace my-gardener --source-root "$PWD"
```

Gardener creates an Access bypass for the runtime hostname only. The bypass grants network
reachability, nothing more: every session still requires a valid GitHub OIDC token. The token is
used in memory and never stored.

Alternatively, exclude the runtime hostname from the Access policy yourself, for example with a
bypass application for that hostname only, and rerun `deploy`. It continues once `/health` is
reachable without Access.

## Changing tasks

Edit `.gardener/tasks/<task>/TASK.md`, then run `gardener generate` and commit the updated lock
file and workflows. Nothing else is needed. When the change reaches the default branch, the
generated `gardener-sync.yml` workflow compiles the tasks with the pinned release's compiler and
enrolls exactly those:

- new and edited tasks go live, and deleted tasks stop;
- `draft: true` tasks run only by hand;
- reverting a task brings its earlier version back.

The sync is refused unless it is Gardener's pinned sync workflow, at the repository's enrolled
release or the release the Worker was deployed from, running on the default branch of a connected
repository. A sync from the Worker's release moves the repository to that release. `deploy`
refuses to replace a runtime from a newer CLI, so this never moves a repository backwards.

If the committed lock or workflows don't match the tasks (someone edited a `TASK.md` without
rerunning `generate`), the sync run fails, and the previously enrolled tasks keep running. Rerun
`generate` and commit. Pull requests that touch Gardener's files get a **Check tasks** check that
reports the same problem before merge. It runs read-only, with no token and no call to the
runtime, so it is safe on pull requests from forks. It only runs on pull requests that touch
those files, so don't make it a required status check: other pull requests would wait for it
forever. A pull request can edit its own checks anyway, so the sync after merge remains the
enforcement. To resync by hand, run the **Gardener · Sync tasks** workflow from the
Actions tab, or run `connect` from an up-to-date checkout of the default branch. `connect` also
starts a sync from the default branch, which replaces the bundles it enrolled from your checkout.
If that run goes red, the default branch's generated files are older than your checkout's: merge
the regenerated files.

Anyone who can push to the default branch decides what Gardener may do there. Protect it with
required reviews or a CODEOWNERS entry for `.gardener/**` if that matters for the repository.

## Inspecting runs

```bash
pnpm gardener -- repositories --workspace my-gardener --source-root "$PWD"
pnpm gardener -- tasks        --workspace my-gardener --source-root "$PWD"
pnpm gardener -- runs         --workspace my-gardener --source-root "$PWD"
pnpm gardener -- runs view --run <run-id> --workspace my-gardener --source-root "$PWD"
```

`runs view` prints the run, its effect receipt, and its audit records.

## Kill switch

```bash
pnpm gardener -- repository disable --workspace my-gardener --repository my-org/my-repo --source-root "$PWD"
```

`repository disable` blocks planning, apply and syncs for every task in the repository. It takes
effect immediately and is recorded in `actions_control_audit`. Use `repository enable` to reverse
it. To stop a single task, delete it or set `draft: true` on the default branch.

## Qualification

After pushing the generated demo workflows:

```bash
pnpm gardener -- debug --workspace my-gardener --repository my-org/my-repo \
  --repository-root /path/to/my-repo --source-root "$PWD"
```

`debug` opens one issue per demo task and waits for both workflows. It then checks for exactly
one Gardener comment and one matching receipt in D1. Add `--drills` to also check that a disabled
repository is refused and that cancellation settles correctly.

## Upgrade

Existing repositories keep their workflow pin until you move them:

```bash
pnpm gardener -- upgrade --workspace my-gardener \
  --repository-root /path/to/my-repo --source-root "$PWD"
```

`upgrade` performs these steps:

1. redeploys the Worker from the current source;
2. moves the repository to this CLI's workflow pin;
3. rebuilds the workflows;
4. moves `package.json` scripts that run a pinned `@scuffi/gardener` (such as a
   `gardener:generate` script) to this release;
5. runs `doctor`.

Run it once per repository, then commit and push the regenerated files. The repository keeps
running on its previous release until they reach the default branch, where the sync moves it to
the new one. Runs from the new workflows are accepted in between, because the Worker also trusts
its own release, so nothing is refused while the sync catches up.

Some releases change the bundle format, which changes every bundle hash. After such a release's
Worker is deployed, runs for a repository fail with `Stored task bundle predates this Gardener
runtime` until that repository has been upgraded and its regenerated workflows pushed.

To go back to an earlier release, deploy or upgrade from that release's CLI. `deploy` refuses to
replace a newer runtime, so this needs a newer release that reverts the change. Migrations are
forward-only.

Gardener has no teardown command. To remove an installation, delete its `gardener-<workspace>`
Worker and D1 database, and any Access application for its hostname, in the Cloudflare dashboard.

## Using a coding agent

A coding agent should drive the same CLI rather than call Wrangler, the Cloudflare API, or the
GitHub API directly. A prompt that works:

```text
Set up Gardener in this repository using only the Gardener CLI.

1. Check `gh auth status` and `wrangler whoami` without printing credentials.
2. Ask me for a short lowercase workspace name.
3. Run `pnpm gardener -- yolo --workspace <name> --repository <owner/name> --demos`, passing
   --repository-root and --source-root explicitly.
4. If it stops, rerun the identical command. Do not recreate any step by hand.
5. Show me the generated files, runtime URL, bundle hashes, and doctor result.
6. Do not commit or push.
```
