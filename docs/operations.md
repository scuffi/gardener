# Operations

All commands run from a Gardener source checkout as `pnpm gardener -- <command>`. Most commands
take these three flags:

| Flag | Meaning |
| --- | --- |
| `--workspace <name>` | Names the installation. It picks the Cloudflare resource names and the local state directory. |
| `--repository-root <path>` | Points at the customer repository. It defaults to the current directory. |
| `--source-root <path>` | Points at the trusted Gardener checkout used to build and deploy the Worker. |

`gardener <command> --help` lists every option.

## Prerequisites

- Node.js 24+ and pnpm 11.25.
- `wrangler login` and `gh auth login` completed for the target accounts.
- The customer repository's Actions must be able to use `scuffi/gardener`'s reusable workflow.
  While Gardener is private, that means a repository owned by the same account, with this
  repository's **Settings → Actions → Access** set to allow it.
- If any task opens pull requests or approves reviews, turn on **Allow GitHub Actions to create and
  approve pull requests** in the customer repository's **Settings → Actions → General → Workflow
  permissions**. It is off by default for new repositories. Without it, apply stops at the
  pull-request step with `GitHub Actions is not permitted to create or approve pull requests`,
  and rerunning the failed job after enabling it resumes from that step. `doctor`, which `up` and
  `upgrade` also run, warns when the setting is off. Leave the default workflow
  permissions at read-only: each generated workflow requests exactly the permissions its task needs.

## Install

```bash
pnpm gardener -- up \
  --workspace my-gardener \
  --repository my-org/my-repo \
  --repository-root /path/to/my-repo \
  --source-root "$PWD" \
  --demos
```

`up` runs `init`, `build`, `deploy`, `connect`, and `doctor` in order. Each step can also be run on
its own:

| Command | Effect | Remote changes |
| --- | --- | --- |
| `init [--demos]` | Creates `.gardener/`, optionally with the two demo tasks | None |
| `build` | Compiles tasks, writes the lock file and one workflow per task | None |
| `deploy` | Creates the D1 database, applies the migration, deploys the Worker, checks `/health` | Cloudflare |
| `connect` | Enrolls the repository and its bundle hashes, sets `GARDENER_RUNTIME_URL` | D1, GitHub variable |
| `doctor` | Verifies the installation. Warns about enrollments whose workflow pin differs from this CLI, and repositories whose tasks open or approve pull requests without the setting below | None |

`init` and `build` never overwrite existing task files or workflows that Gardener did not generate.
Rebuilding unchanged tasks produces byte-identical output. No command commits or pushes, so review
the generated files and commit them yourself.

Deployment is checkpointed in `~/.config/gardener/<workspace>/actions/`, with files readable only
by you. If a command is interrupted, rerun it unchanged. Do not edit these files by hand.

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

Edit `.gardener/tasks/<task>/TASK.md`, then:

```bash
pnpm gardener -- build --repository-root /path/to/my-repo
pnpm gardener -- connect --workspace my-gardener --repository my-org/my-repo \
  --repository-root /path/to/my-repo --source-root "$PWD"
```

Commit the updated lock file and workflows. `connect` enables the new bundle hashes and retires
the old ones for that repository. A retired hash is never re-enabled automatically.

## Inspecting runs

```bash
pnpm gardener -- repositories --workspace my-gardener --source-root "$PWD"
pnpm gardener -- tasks        --workspace my-gardener --source-root "$PWD"
pnpm gardener -- runs         --workspace my-gardener --source-root "$PWD"
pnpm gardener -- run show --run <run-id> --workspace my-gardener --source-root "$PWD"
```

`run show` prints the run, its effect receipt, and its audit records.

## Kill switches

```bash
pnpm gardener -- repository disable --workspace my-gardener --repository my-org/my-repo --source-root "$PWD"
pnpm gardener -- task disable --task <task-id> --workspace my-gardener --repository my-org/my-repo --source-root "$PWD"
```

| Switch | Blocks |
| --- | --- |
| `repository disable` | Planning and apply for every task in the repository |
| `task disable` | New plans for one task. A plan issued before the switch can still be applied. |

Both take effect immediately and are recorded in `actions_control_audit`. Use `enable` to reverse
them.

## Qualification

After pushing the generated demo workflows:

```bash
pnpm gardener -- qualify --workspace my-gardener --repository my-org/my-repo \
  --repository-root /path/to/my-repo --source-root "$PWD"
```

`qualify` opens one issue per demo task and waits for both workflows. It then checks for exactly
one Gardener comment and one matching receipt in D1. Add `--drills` to also check that disabled
repositories and tasks are refused and that cancellation settles correctly.

## Upgrade and rollback

Existing repositories keep their workflow pin until you move them:

```bash
pnpm gardener -- upgrade --workspace my-gardener --repository my-org/my-repo \
  --repository-root /path/to/my-repo --source-root "$PWD"
```

`upgrade` performs these steps:

1. redeploys the Worker from the current source;
2. moves the repository to this CLI's workflow pin;
3. rebuilds the workflows;
4. re-enrolls the repository;
5. runs `doctor`.

Run it once per repository, then commit the regenerated workflows.

Each deploy records a digest of the Worker bundle and migrations. To roll back code, check out the
earlier Gardener source and pass its recorded digest:

```bash
pnpm gardener -- rollback --workspace my-gardener \
  --source-root /path/to/earlier/gardener --confirm <source-digest>
```

Rollback refuses a digest that is not in the deployment history. Migrations are forward-only:
rollback restores code, not schema.

## Teardown

Teardown takes two steps. The first prints a digest describing exactly what will be deleted. The
digest is valid for 24 hours.

```bash
pnpm gardener -- down --workspace my-gardener --source-root "$PWD"
pnpm gardener -- down --workspace my-gardener --source-root "$PWD" --execute --confirm <digest>
```

It deletes the Worker, the D1 database, and any Access bypass Gardener created. It refuses to run
if the resources no longer match the recorded installation. Generated files in your repository are
left in place.

## Using a coding agent

A coding agent should drive the same CLI rather than call Wrangler, the Cloudflare API, or the
GitHub API directly. A prompt that works:

```text
Set up Gardener in this repository using only the Gardener CLI.

1. Check `gh auth status` and `wrangler whoami` without printing credentials.
2. Ask me for a short lowercase workspace name.
3. Run `pnpm gardener -- up --workspace <name> --repository <owner/name> --demos`, passing
   --repository-root and --source-root explicitly.
4. If it stops, rerun the identical command. Do not recreate any step by hand.
5. Show me the generated files, runtime URL, bundle hashes, and doctor result.
6. Do not commit or push.
```
