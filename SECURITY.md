# Security

## Reporting a vulnerability

Report vulnerabilities privately to the maintainers through GitHub's private vulnerability
reporting on this repository. Do not put credentials, private repository content, model prompts, or
workflow logs from a private repository in a public issue.

## Deployment model

Each installation is self-hosted. It consists of one Cloudflare Worker with a D1 database and
Workers AI in the operator's Cloudflare account, plus generated workflows in each enrolled
repository. The installation is the tenant boundary. Gardener runs no shared service and receives
no data from installations.

The Worker holds no GitHub credential. Repository access comes only from the `GITHUB_TOKEN` that
GitHub issues to each workflow job, with permissions fixed by the generated workflow.

## Trust boundaries

| Component | Trusted with | Never receives |
| --- | --- | --- |
| Worker | Task bundles, run state, plan validation, receipts | Any GitHub token |
| Plan job | Read-only `GITHUB_TOKEN`, OIDC token, checkout | Write permissions |
| Model and `repository.exec` | Repository contents, via declared tools only | Any GitHub token, the OIDC token |
| Apply job | Write scopes implied by the task's declared effects | A checkout, repository code, model output other than the validated plan |

Untrusted inputs are:

- model output;
- repository contents;
- issue, pull request, and comment bodies;
- anything a `repository.exec` process writes.

Each one can influence what is proposed. None of them can widen what is allowed.

## Session authentication

The Worker exposes two routes: `GET /health` and `/session/<id>`. Every other path returns 404.
Opening a session grants nothing until the runner presents a GitHub OIDC token. The Worker verifies
the token signature against GitHub's issuer and requires all of the following:

- the enrolled numeric repository and owner IDs;
- the run ID and attempt, the event name, the ref, and the commit SHA;
- a GitHub-hosted runner, `runner_environment: github-hosted`;
- the exact reusable workflow reference, `job_workflow_ref`, pinned to a full commit SHA;
- the Worker's own origin as audience;
- the job phase, plan or effects.

Tokens bound to a GitHub environment are rejected. A disabled repository cannot authenticate either
phase.

## Planning

- The plan job checks out with `persist-credentials: false`. Its token is read-only.
- Task definitions are canonical `TaskBundleV1` JSON stored by SHA-256. The Worker loads only
  hashes enrolled for the authenticated repository, recomputes the hash, and checks the event
  against the task's declared triggers. It never parses Markdown or YAML.
- The model reaches the repository only through the task's declared tools.
  - `provider.api.read` allows REST `GET`/`HEAD` and GraphQL queries. The bridge process holds the
    token, so it never reaches model context or a child process.
  - `repository.exec` runs with the token and OIDC request variables removed from its environment.
- The model proposes effects one at a time. It supplies a step name, an operation kind, a payload,
  and references to earlier steps' outputs. The Worker validates each proposal against three
  constraints:
  - the task's declared effects;
  - the strict operation schema;
  - typed references, which may point only to scalar outputs of earlier steps.
- The Worker derives the parts the model must not control:
  - operation IDs;
  - repository identity;
  - idempotency markers;
  - commit file contents.
- Fork pull requests are rejected twice: in the generated workflow, and by a runtime head-repository
  check. `pull_request_target` cannot be generated.

### Captured changes

A task that commits code does not put file bytes in its plan. When a commit is proposed, the
bridge captures the working tree changes into a separate artifact. The manifest records each path's status, mode,
size, and SHA-256, and the plan binds the manifest digest.

A capture may not write these paths:

- anything under `.git/`, `.github/workflows/`, `.github/actions/`, or `.gardener/`;
- `CODEOWNERS`, `.github/CODEOWNERS`, and `docs/CODEOWNERS`;
- `.github/dependabot.yml` and `.github/dependabot.yaml`.

Apply verifies the artifact against the plan, then re-verifies each file's size and digest as it
uploads the file.

## Apply

The apply job has no checkout and runs no repository code. It performs these steps:

1. Download the plan artifact and verify its SHA-256.
2. Authenticate as the effects phase.
3. Have the Worker confirm the plan is the one it issued for this run.
4. Execute each operation in order.

Every operation carries the GitHub state it was planned against. Depending on the operation, that
can include:

- the issue or pull request state and `updated_at`;
- the head SHA;
- the comment timestamps;
- the release state.

Apply re-reads that state before writing. A mismatch is a terminal conflict, never a retry.

Apply stops at the first failure. Re-running the apply job resumes after the last operation that
succeeded exactly. Operations can be matched after an interrupted run through markers that trusted
code adds:

- an HTML comment, `<!-- gardener-operation:<id> -->`, on comments, reviews, and pull request
  bodies;
- a `Gardener-Operation:` trailer on commits.

Gardener branches and commits are limited to `gardener/*` branches. No operation can force-push or
delete a branch.

## Known limitations

- **No human approval.** Declared effects apply automatically. A task that declares merge,
  release, or check-rerun authority can use it unattended.
- **Unrestricted egress from `repository.exec`.** It runs as the runner user with the runner's
  normal network access, so it can exfiltrate anything in the checkout. A hostile process can also
  tamper with the plan job's step outputs. It cannot change what is applied: the Worker
  independently re-derives the plan and its digest before apply, and any mismatch fails closed.
- **Task kill switch.** `gardener task disable` stops new plans. It does not revoke a plan issued
  before the switch. `gardener repository disable` blocks both phases.

## Operator secrets

`.gardener/` and the generated workflows contain no secrets. The CLI keeps installation state under
`~/.config/gardener/<workspace>/`, with directory mode `0700` and file mode `0600`.

A `CLOUDFLARE_API_TOKEN`, when provided for Cloudflare Access, is used in memory only. It is never
written to disk, D1, the Worker, GitHub, or command arguments.

If you suspect compromise, disable the repository with `gardener repository disable`. Preserve the
D1 database. The database blocks updates and deletes on the run audit table, `actions_task_audit`, so
its rows serve as evidence.
