# CLI reference

The CLI is published as [`@scuffi/gardener`](https://www.npmjs.com/package/@scuffi/gardener). Run it
with `npx @scuffi/gardener <command>`, or pin it in your repository's `package.json`. It needs
Node.js 24 or later. Commands that change Cloudflare use your Wrangler login (`npx wrangler login`);
commands that change GitHub use the GitHub CLI's (`gh auth login`).

A **workspace** is one Gardener installation on a Cloudflare account. Its resources are named
`gardener-<workspace>`, and the CLI finds them there rather than keeping local state, so anyone with
access to the account can run any command. One installation can serve many repositories.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy`, `yolo`, `upgrade` | The account to deploy to, when your Wrangler login can see several. |
| `CLOUDFLARE_API_TOKEN` | `deploy`, `yolo`, `upgrade` | Needed only if Cloudflare Access protects every `workers.dev` hostname on the account: a token with **Access: Apps and Policies Edit**, so `deploy` can let GitHub Actions reach the runtime. |
| `GARDENER_AI_GATEWAY_TOKEN` | `deploy --ai-gateway` | Token for an AI Gateway in another account. Stored as a Worker secret, never on disk. |

## Commands

<!-- generated:commands -->
```text
gardener <command>

Commands:
  init                         Create a local .gardener project
  generate                     Compile TASK.md files and generate caller workflows
  deploy                       Deploy the Gardener runtime to Cloudflare
  connect                      Connect a repository to the runtime (once per repository)
  upgrade                      Redeploy the runtime and move a repository's files to this release
  yolo                         Init, generate, deploy, connect, and verify
  doctor                       Verify an existing installation
  debug                        Run both demo workflows and verify exact receipts
  repositories                 List connected repositories
  repository disable|enable    Stop or resume every task in a repository
  tasks                        List enrolled tasks
  runs                         List recent runs
  runs view                    Show one run and its audit records

Run `gardener <command> --help` for command options.
```

### `init`

```text
gardener init

Creates a local, secret-free Gardener project. This command never mutates Cloudflare or GitHub.

Options:
  --demos                      Add the bug-intake and documentation-helper demo tasks
  --repository-root <path>     Customer repository (defaults to current directory)
```

### `generate`

```text
gardener generate

Compiles .gardener/tasks/*/TASK.md into canonical TaskBundleV1 records, writes the
reproducible lock file, and generates one GitHub caller workflow per task. Also refreshes
.gardener/SKILL.md, the guide coding agents read before writing tasks.

Options:
  --repository-root <path>     Customer repository (defaults to current directory)
```

### `deploy`

```text
gardener deploy

Deploy or update the Gardener runtime on Cloudflare. Existing gardener-<workspace>
resources on the account are adopted; a runtime from a newer CLI is never replaced.

Options:
  --workspace <name>           Stable installation name
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
  --ai-gateway <account>/<id>  Send non-Workers-AI models to this AI Gateway, which may be in
                               another account; its token comes from GARDENER_AI_GATEWAY_TOKEN.
                               "off" removes it. Omitted keeps the current gateway
  --ai-gateway-project <name>  Project sent as cf-aig-metadata on every gateway request
```

### `connect`

```text
gardener connect

Connect a repository once: enroll it, upload its compiled bundles, set its non-secret runtime
URL variable, and start the sync workflow on its default branch if it is there yet. Bundles not in
this checkout are disabled until that sync, so run it from the default branch.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    GitHub repository to enroll
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
```

### `upgrade`

```text
gardener upgrade

Upgrade an existing runtime, move one repository's files to this release's pinned workflows,
regenerate them, and verify the installation. Commit and push the result: the sync workflow enrols
it when it reaches the default branch. Existing projects never upgrade implicitly through the yolo
command.

Options:
  --workspace <name>           Existing Gardener installation
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
```

### `yolo`

```text
gardener yolo

Scaffold, compile, deploy, connect, and verify a reproducible Gardener installation.

Options:
  --workspace <name>           Stable installation name
  --repository <owner/name>    GitHub repository to enroll
  --demos                      Add the two bounded demo tasks
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
```

### `deploy`

```text
gardener deploy

Deploy or update the Gardener runtime on Cloudflare. Existing gardener-<workspace>
resources on the account are adopted; a runtime from a newer CLI is never replaced.

Options:
  --workspace <name>           Stable installation name
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
  --ai-gateway <account>/<id>  Send non-Workers-AI models to this AI Gateway, which may be in
                               another account; its token comes from GARDENER_AI_GATEWAY_TOKEN.
                               "off" removes it. Omitted keeps the current gateway
  --ai-gateway-project <name>  Project sent as cf-aig-metadata on every gateway request
```

### `debug`

```text
gardener debug

Create one disposable issue per compiled task, wait for both generated workflows, and verify the
unique GitHub comment and D1 receipt for each bundle. Add --drills for kill-switch, cancellation,
and reconciliation-invariant qualification.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    Connected GitHub repository
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
  --drills                     Also run negative admission and cancellation drills
  --drills-only                Reuse recent successful runs and execute only the drills
```

### `<repositories|tasks|runs|runs view|repository disable|repository enable>`

```text
gardener <repositories|tasks|runs|runs view|repository disable|repository enable>

repository disable stops every task in a repository straight away, whatever is on its default
branch; repository enable resumes them.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    Optional repository filter or required control target
  --run <id>                   Run identity for runs view
  --limit <1-100>              Maximum runs to list
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
```
<!-- /generated:commands -->
