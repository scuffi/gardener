#!/usr/bin/env node
import { parse } from "./args.js";
import { destroyQualification } from "./destroy.js";
import { initializeGateway } from "./init.js";
import { doctor, retryDelivery } from "./operator.js";
import { planGateway } from "./plan.js";
import { qualifyGateway } from "./qualify.js";
import { smokeGateway } from "./smoke.js";
import { setupGardener } from "./setup.js";

const HELP = `gardener <command>

Commands:
  setup                        Plan, provision, link, and verify a Gardener workspace
  gateway <command>            Operate, qualify, or diagnose the GitHub Gateway

Run \`gardener setup --help\` or \`gardener gateway help\` for details.
`;

const SETUP_HELP = `gardener setup

Plans, confirms, provisions, and verifies one customer-owned Gardener workspace.
The command is checkpointed and safe to rerun after interruption.

Options:
  --workspace <name>           Workspace and deterministic Cloudflare resource suffix
  --owner <github-login>       Immutable permanent workspace owner
  --personal                   Create the App in the signed-in personal GitHub account
  --organization <login>       Create the App under a GitHub organization
  --repository-root <path>     Gardener checkout (defaults to current directory)
`;

const GATEWAY_HELP = `gardener gateway <command>

Commands:
  plan                         Build and dry-run the generated topology; no remote mutation
  init                         Provision and link a Gardener GitHub Gateway
  doctor                       Show sanitized health and delivery diagnostics
  smoke                        Validate credentials, RPC bindings, capabilities, and delivery state
  qualify                      Run qualification init + smoke + mandatory Cloudflare teardown
  retry <delivery-id>          Retry one persisted failed delivery
  destroy                      Delete an explicitly marked qual-* Cloudflare stack

Options:
  --workspace <name>           Local workspace/config name
  --owner <github-login>       Permanent owner for init
  --owner-id <numeric-id>      Required with --yes; must match GitHub lookup
  --organization <login>       Create the GitHub App under an organization
  --qualification              Mark a qual-* init as safe for guarded teardown
  --yes                        Non-interactive owner confirmation
  --dry-run                    Explicitly request non-mutating destroy output (the default)
  --execute                    Execute a guarded qualification-stack destroy
  --confirm <workspace>        Exact workspace confirmation required with --execute
  --repository-root <path>     Gardener checkout (defaults to current directory)
`;

async function main(argv: string[]): Promise<void> {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const [scope, command, ...rest] = normalized;
  if (!scope || scope === "help" || scope === "--help") {
    console.log(HELP);
    return;
  }
  if (scope === "setup") {
    if (command === "help" || command === "--help") {
      console.log(SETUP_HELP);
      return;
    }
    const setupArgs = command ? [command, ...rest] : rest;
    const { positional, flags } = parse(setupArgs);
    if (positional.length) throw new Error("gardener setup does not accept positional arguments");
    const workspace = stringFlag(flags, "workspace");
    const owner = stringFlag(flags, "owner");
    const organization = stringFlag(flags, "organization");
    const repositoryRoot = stringFlag(flags, "repository-root");
    await setupGardener({
      ...(workspace ? { workspace } : {}),
      ...(owner ? { owner } : {}),
      ...(organization ? { organization } : {}),
      ...(repositoryRoot ? { repositoryRoot } : {}),
      personal: flags.get("personal") === true,
    });
    return;
  }
  if (scope !== "gateway") {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  if (!command || command === "help" || command === "--help") {
    console.log(GATEWAY_HELP);
    return;
  }
  const { positional, flags } = parse(rest);
  const workspace = stringFlag(flags, "workspace");
  const repositoryRoot = stringFlag(flags, "repository-root");
  if (command === "plan") {
    if (!workspace || positional.length) {
      throw new Error("Usage: gardener gateway plan --workspace <name>");
    }
    await planGateway({
      workspace,
      ...(repositoryRoot ? { repositoryRoot } : {}),
    });
    return;
  }
  if (command === "init") {
    const owner = stringFlag(flags, "owner");
    const ownerId = stringFlag(flags, "owner-id");
    const organization = stringFlag(flags, "organization");
    await initializeGateway({
      ...(workspace ? { workspace } : {}),
      ...(owner ? { owner } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(organization ? { organization } : {}),
      ...(repositoryRoot ? { repositoryRoot } : {}),
      yes: flags.get("yes") === true,
      qualification: flags.get("qualification") === true,
    });
    return;
  }
  if (command === "qualify") {
    if (!workspace || positional.length) {
      throw new Error("Usage: gardener gateway qualify --workspace qual-<name> --owner <login>");
    }
    const owner = stringFlag(flags, "owner");
    const ownerId = stringFlag(flags, "owner-id");
    const organization = stringFlag(flags, "organization");
    await qualifyGateway({
      workspace,
      ...(owner ? { owner } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(organization ? { organization } : {}),
      ...(repositoryRoot ? { repositoryRoot } : {}),
      yes: flags.get("yes") === true,
    });
    return;
  }
  if (!workspace) throw new Error(`--workspace is required for gateway ${command}`);
  if (command === "doctor") {
    if (positional.length) throw new Error("gateway doctor does not accept positional arguments");
    await doctor(workspace);
    return;
  }
  if (command === "smoke") {
    if (positional.length) throw new Error("gateway smoke does not accept positional arguments");
    await smokeGateway(workspace);
    return;
  }
  if (command === "retry") {
    const [deliveryId, ...extra] = positional;
    if (!deliveryId || extra.length) throw new Error("Usage: gardener gateway retry <delivery-id> --workspace <name>");
    await retryDelivery(workspace, deliveryId);
    return;
  }
  if (command === "destroy") {
    if (positional.length) throw new Error("gateway destroy does not accept positional arguments");
    const execute = flags.get("execute") === true;
    if (execute && flags.get("dry-run") === true) {
      throw new Error("Use either --dry-run or --execute, not both");
    }
    const confirm = stringFlag(flags, "confirm");
    await destroyQualification({
      workspace,
      execute,
      ...(confirm ? { confirm } : {}),
      ...(repositoryRoot ? { repositoryRoot } : {}),
    });
    return;
  }
  throw new Error(`Unknown gateway command: ${command}`);
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Gardener CLI failed");
  process.exitCode = 1;
});
