# Set up Gardener with a coding agent

Gardener's coding-agent setup path does not give an agent a second deployment implementation. The
agent asks for decisions, shows the exact plan, and runs the same checkpointed `gardener setup`
command a human operator uses.

The GitHub App Manifest authorization is always completed by the human in GitHub. Provider secrets
are uploaded directly from the CLI to the Gateway and must never enter the agent conversation.

## Before copying the prompt

Use a trusted, reviewed Gardener checkout. The setup agent will run local commands and, after your
exact confirmation, create resources in your Cloudflare and GitHub accounts.

Requirements:

- Node.js 24+ and pnpm 11.25.0;
- an authenticated Wrangler session with permission to create Workers, D1, R2, Workflows, Durable
  Objects, and Containers;
- permission to create a GitHub App in the selected personal account or organization;
- no existing Cloudflare resources with the deterministic workspace names.

## Copyable prompt

Copy the following into your coding agent from the Gardener repository root:

```text
Set up this Gardener checkout as one customer-owned workspace.

Security rules:
- Treat the Gardener CLI as the only provisioning and secret-handling implementation. Do not
  reproduce setup with ad hoc Wrangler, Cloudflare API, GitHub API, curl, or SQL commands.
- Never read, print, summarize, diff, index, or place in model context .dev.vars,
  setup-recovery.json, gateway-operator-token, GitHub private keys, client secrets, webhook
  secrets, operator tokens, App JWTs, installation tokens, or secret command stdin.
- Do not place any secret in argv, a URL, generated configuration, repository files, logs, or chat.
- Do not delete or replace an existing deployment. Gardener setup creates only a fresh workspace.
- Do not mutate Cloudflare or GitHub until I have confirmed the exact printed setup plan.
- Use an interactive terminal for setup. I will complete GitHub browser authorization myself.
- If interrupted, rerun the same Gardener setup command and let its checkpoint resume. Do not
  invent recovery or compensating writes.

First:
1. Show git status and the exact commit. Stop if the checkout has unexpected uncommitted changes.
2. Run pnpm install, then pnpm check.
3. Ask me for:
   - the lowercase workspace slug;
   - the permanent human owner GitHub login;
   - whether the GitHub App is personal or organization-owned;
   - the organization login when applicable.
4. Run `pnpm gardener -- gateway plan --workspace <workspace>`; this is local and non-mutating.
5. Show the exact derived Worker, D1, R2, Workflow, container, and App ownership plan. Explain that
   the owner login will be bound to its immutable numeric GitHub ID.
6. Ask me to confirm proceeding with remote setup.

After I confirm:
7. Run one of these in an interactive terminal:
   - personal App: `pnpm gardener -- setup --workspace <workspace> --owner <login> --personal`
   - organization App: `pnpm gardener -- setup --workspace <workspace> --owner <login>
     --organization <organization>`
8. Let the CLI perform its own account/name checks and dry-run. When it asks, show me the exact
   plan and ask me to type the CLI's confirmation directly in the terminal.
9. Let the CLI open GitHub. I will confirm the signed-in App owner and submit the Manifest form.
10. After setup completes, run:
    - `pnpm gardener -- gateway doctor --workspace <workspace>`
    - `pnpm gardener -- gateway smoke --workspace <workspace>`
11. Report only non-secret resource names/IDs, public origins, App slug, checkpoint status, smoke
    status, and report paths. Confirm Gardener remains globally paused.
12. Give me the manual OAuth, installation, repository-sync, webhook, failed-delivery retry, exact
    effect, and replay test checklist from docs/github-gateway.md. Do not enable live assignments or
    unpause Gardener without a separate explicit instruction.
```

## Direct human equivalent

A human can run exactly the same setup without a coding agent:

```bash
pnpm install
pnpm check

# Personal App
pnpm gardener -- setup --workspace my-team --owner my-login --personal

# Or organization App
pnpm gardener -- setup \
  --workspace my-team \
  --owner my-login \
  --organization my-organization
```

The CLI performs a local generated-topology dry run and displays the selected Cloudflare account,
immutable owner identity, App ownership, deterministic resource names, deployment order, and remote
mutations. Remote creation starts only after the operator types the exact confirmation shown by the
CLI.

## Browser and recovery behavior

The CLI opens a localhost page that posts the App Manifest directly to GitHub. Confirm that GitHub is
signed into the intended personal or organization owner before submitting it. The agent does not
need, and must not receive, the callback code or returned credentials.

If setup stops after GitHub returns credentials, rerun the same `gardener setup` command. The CLI
resumes from owner-only state under `~/.config/gardener/<workspace>/`; it uploads credentials through
Wrangler stdin and removes `setup-recovery.json` only after verification succeeds.

After setup, `gateway-operator-token` remains owner-only for doctor and explicit delivery retry. Do
not copy it into the repository or coding-agent context.
