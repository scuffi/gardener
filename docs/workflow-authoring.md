# Workflow authoring and controls

Status: implementation design for the next Gardener development slice.

## Product intent

The dashboard is the primary workflow product. It must make useful automations discoverable, understandable, and configurable without code. The same versioned representation is also the integration surface for future local coding agents; the dashboard and agent tooling must not become separate workflow systems.

A workflow is a bounded declaration of:

1. **When** it is considered: trigger and event actions.
2. **Where** it applies: selected repositories and resources.
3. **If** it is eligible: typed conditions over trusted context.
4. **Then** what it may propose: registered, typed operations.
5. **How** it runs: a registered runtime profile and bounded instructions.
6. **Within what limits**: operations, tokens, cost, retries, and runtime.

Workflow definitions never contain GitHub credentials, arbitrary executable code, or instance operation policy modes. A workflow may carry only a restrictive authority ceiling; it can reduce an instance policy from Automatic to Approval or Disabled, never increase it.

## Authority boundaries

Gardener evaluates independent layers. A less-trusted layer can narrow authority but cannot broaden a more-trusted layer.

1. Instance and repository admission controls, including global and repository pause.
2. Workflow trigger, repository scope, and eligibility conditions.
3. The workflow's registered operation allowlist and execution limits.
4. Instance and repository operation policies: Disabled, Approval, or Automatic.
5. Connect's exact-operation grant, live resource preconditions, GitHub permissions, and branch protection.

A workflow cannot change its own operation policies. Publishing or activating a workflow cannot enable an operation whose policy is Disabled. Future conditional security policies may reduce Automatic to Approval or Disabled; they cannot turn a Disabled operation into Automatic from within a workflow.

Authoring authorization is separate from execution authorization. Initial dashboard authoring remains owner-only. Future local-agent credentials are scoped to reading, validating, dry-running, and publishing paused drafts. They cannot activate a revision or modify operation policies.

User and group controls occur in three separate domains and must not be collapsed into one ambiguous rule:

- **Event eligibility**: whose GitHub action or authored resource may cause this workflow to run.
- **Workflow administration**: who may view, edit, publish, activate, enable, or disable workflow revisions.
- **Operation guardrails**: whose context may permit an operation to remain Automatic, require Approval, or become Disabled.

These domains may reuse the same typed principal selectors and condition evaluator, but each has its own capability allowlist and enforcement point.

## No-code dashboard

The Workflows area should have two connected surfaces.

### Showcase

A template gallery explains the outcome, trigger, required capabilities, operations, and safety posture before a workflow is created. Initial entries should include:

- Issue triage.
- Issue labels only.
- Helpful issue response.
- Dependabot auto-merge, marked unavailable until the pull-request runtime and check-aware operation are installed.

Templates create ordinary editable drafts. They do not receive privileged behavior.

### Builder

The builder uses an ordered operational layout rather than an unrestricted graph canvas:

1. Basics.
2. Trigger.
3. Repositories.
4. Conditions.
5. Actions and instructions.
6. Controls and limits.
7. Review, validate, and publish draft.

This maps directly to the declarative definition while remaining approachable. An advanced representation may be shown for inspection and future import/export, but raw JSON or YAML is not the primary interface.

The review step must show:

- A plain-language summary of when the workflow runs.
- An explicit distinction between event actor and resource author conditions.
- The exact repositories and operations.
- Current effective policy modes for those operations.
- Unsupported or unavailable capabilities.
- Differences from the active revision.
- Whether activation would affect an enabled workflow.

Saving creates a new immutable draft revision. Activation is an explicit human action. Enabling or disabling the workflow remains a separate control.

## Conditions and future security controls

Conditions use a bounded, versioned expression tree:

- `all`: every child must match.
- `any`: at least one child must match.
- `not`: invert a resolved child result.
- `predicate`: compare a registered field with a typed value using a registered operator.

The evaluator is tri-state: `matched`, `not_matched`, or `unresolved`. Missing or unavailable trusted attributes are never treated as a successful negative comparison. `not(unresolved)` remains `unresolved`, and an unresolved required expression fails closed.

Expression depth, node count, string lengths, and list sizes are bounded. Regular-expression input is not accepted in the initial condition language.

Each condition field is registered in a capability catalog containing:

- Stable field identifier.
- Human label and description.
- Value type and allowed operators.
- Compatible event/resource kinds.
- Trust source.
- Availability and any required GitHub permission.

Initial signed-event fields include repository identity, event action, the legacy resource-author login hint, resource state, labels, and pull-request base/head and draft state. Stable event-actor and resource-author identities remain planned until Gardener instances negotiate an identity-aware event contract; managed Connect must continue sending the exact strict v1 envelope to older independently deployed Workers.

The event actor and resource author are distinct capabilities and must have unambiguous UI labels:

- **Person or App that caused this event**: the GitHub webhook `sender`.
- **Original issue or pull request author**: the resource owner.

When the negotiated event contract is added, Connect must preserve numeric GitHub identity IDs and account types for both. Login strings are display hints, not the security identifier. A maintainer labeling a Dependabot pull request has a maintainer event actor and a Dependabot resource author.

Capability IDs are independently versioned, for example `github.event.actor.identity@v1`. Their provenance is classified as Connect-attested identity, Connect-attested scope, Connect-resolved authorization, Connect-resolved mutable state, GitHub content, deterministic derived data, or model-derived data. Content and model-derived values may route or narrow work but never prove identity or authorization.

Future fields include repository permission, organization role, GitHub team membership, changed paths, dependency metadata, check conclusions, and trusted system time windows. Team membership and repository permissions must be resolved by Connect with installation credentials and signed or grant-bound for Gardener; they must not be inferred from issue text, pull-request text, model output, or client input. Time-window evaluation uses trusted Worker time and an explicit IANA time zone.

Unknown fields, operators, runtime profiles, and operation kinds fail validation. A definition using a known but unavailable capability may be stored as a draft but cannot be activated.

Evaluation occurs in phases:

1. **Activation validation** confirms capabilities, permissions, trigger compatibility, explicit repository IDs, runtime support, and operation ceilings.
2. **Admission** evaluates immutable event facts and may reject known non-matches before AI runs.
3. **Pre-run** will resolve required live authorization and resource facts through Connect when those capabilities become available; the complete expression must be `matched` before invoking a runtime.
4. **Pre-operation** will re-resolve mutable and authorization-sensitive facts before automatic execution and again when an approved proposal is executed. Until that resolver exists, a workflow that follows instance policy cannot activate with conditions whose truth may become stale; approval-ceiling workflows require an explicit human decision.

The compiler performs static authority-path analysis for high-impact automatic operations. Every satisfiable branch of an `any` condition must contain the required positive trusted anchors; `trusted identity OR label contains safe-to-merge` is not safe because the label-only branch bypasses identity.

## Immutable revisions

The existing `workflows` row remains the active pointer and runtime projection. A new `workflow_revisions` table stores immutable definitions and compiled plans:

- Workflow ID and monotonically increasing revision.
- Canonical definition JSON.
- Compiled plan JSON and stable source hash.
- Source (`system`, `dashboard`, or later `agent`).
- Creating principal and timestamp.
- Explicit repository IDs; “all selected repositories” is compiled to the current ID set and never silently includes future installations.
- Required GitHub permissions and a versioned condition-resolver/capability-catalog identifier.

Creating or saving a draft inserts a revision. Activating a revision updates the active projection in `workflows`; it never rewrites the revision. Runs continue to bind the exact workflow revision and a separate operation-policy snapshot. Compiled plans contain no instance policy object or policy modes.

V2 admission writes an explicit run-to-plan binding containing the plan ID and content hash. Queue execution loads instructions, the resolved runtime model, conditions, capabilities, and limits only through that immutable binding; a version number alone never retroactively opts a legacy run into V2. Runs admitted before backfill have no binding and retain the temporary legacy fallback. The first validated agent result is frozen per run, so retries cannot substitute different proposal payloads or exceed the cumulative operation ceiling. A partially processed legacy run that already has proposals but no frozen result fails terminally for manual review; it never invokes AI again or creates a second set of operations.

The existing Issue Gardener is backfilled as revision 1 without changing its live behavior. Input is rejected conservatively before Workers AI when it exceeds the token budget, the provider receives the exact output-token ceiling, and activation requires a model with known pricing whose maximum token-budget cost fits the workflow cost limit. Runtime timeouts are terminal because the Workers AI binding cannot cancel an in-flight call safely.

## Management API

Human-session endpoints:

- `GET /api/workflow-capabilities`
- `GET /api/workflow-templates`
- `GET /api/workflows/:id`
- `POST /api/workflows/validate`
- `POST /api/workflows` to create a draft
- `POST /api/workflows/:id/revisions` to create the next draft
- `POST /api/workflows/:id/revisions/:revision/dry-run`
- `POST /api/workflows/:id/revisions/:revision/activate`
- Existing enable/disable endpoint remains separate

Validation responses use stable field paths so the no-code editor can focus the failing control. Revision creation uses an expected latest revision to reject concurrent edits.

A later scoped token authenticator may call only the read, validation, dry-run, and draft-publication endpoints. Access-hardened deployments additionally require an appropriate outer Cloudflare Access identity; the Connect service token is not reused for local agents.

## Local coding agents

After the dashboard vertical slice, a CLI and MCP server reuse the same contracts and API:

- Get the workflow schema and capability catalog.
- List and export active workflows.
- Validate a local definition.
- Explain or dry-run a definition.
- Diff against the active revision.
- Publish a paused draft.

Credentials are stored outside repositories with owner-only file permissions. Agents never receive the Gardener instance bootstrap token, GitHub App private key, installation token, or Connect signing keys.

## Dependabot auto-merge

A safe Dependabot workflow requires capabilities beyond the deployed issue runtime:

- Pull-request workflow triggers.
- Exact numeric resource-author identity and account-type matching for Dependabot; `dependabot/` branches and PR titles do not prove identity.
- Exact event-actor identity matching for event paths that are intended to trust a Dependabot-authored update.
- Current head/base revision binding.
- Check and branch-protection evidence.
- A check-aware typed `pull_request.auto_merge.enable` operation, preferably enabling GitHub native auto-merge so GitHub waits for required checks rather than repeatedly attempting an immediate merge. Its receipt means enrollment was enabled, not that the PR has merged.
- A separately configured operation policy that initially defaults to Disabled.

The template should require open, non-draft Dependabot pull requests against an allowed base branch and a configured merge method. Connect must re-read and verify all security-sensitive PR state immediately before the operation. The workflow cannot bypass branch protection or grant itself Automatic mode.

## Delivery sequence

1. Add the condition/capability contracts and evaluator with fail-closed tests.
2. Add immutable workflow revision storage and compatibility backfill.
3. Add validation, draft, detail, activation, and capability APIs.
4. Build the responsive template gallery and no-code editor.
5. Wire issue workflows to immutable active revisions and operation allowlists.
6. Extend browser smoke coverage for create, edit, validation, revision diff, activation, and mobile layouts.
7. Add the pull-request runtime and check-aware auto-merge operation.
8. Add scoped draft-publisher tokens, CLI, and MCP tools.
