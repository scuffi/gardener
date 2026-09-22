#!/usr/bin/env node
import {
  connectActions,
  deployActions,
  destroyActions,
  doctorActions,
  rollbackActions,
  upgradeActions,
} from "./actions-installation.js";
import {
  listActionsRepositories,
  listActionsRuns,
  listActionsTasks,
  setRepositoryEnabled,
  setTaskEnabled,
  showActionsRun,
} from "./actions-operations.js";
import { qualifyActions } from "./actions-qualify.js";
import { parse } from "./args.js";
import { buildProject, initializeProject, upgradeProjectRelease } from "./project.js";
import { defaultSourceRoot } from "./distribution.js";
import { terminal } from "./terminal.js";

const HELP = `gardener <command>

Commands:
  init                         Create a local .gardener project
  build                        Compile TASK.md files and generate caller workflows
  deploy                       Provision the headless Actions-native Cloudflare runtime
  upgrade                      Upgrade runtime and one repository bridge pin
  rollback                     Redeploy an explicitly confirmed historical source digest
  connect                      Enroll a GitHub repository and its compiled task bundles
  up                           Init, build, deploy, connect, and verify
  doctor                       Verify an existing Actions-native installation
  qualify                      Run both demo workflows and verify exact receipts
  task <enable|disable>        Immediately enable or disable one enrolled task
  repository <enable|disable>  Immediately enable or disable one repository
  repositories                 List enrolled repositories
  tasks                        List enrolled task bundles
  runs                         List recent Actions-native runs
  run show                     Show one run and its audit records
  down                         Preview or execute manifest-guarded teardown

Run \`gardener <command> --help\` for command options.
`;

const OPERATIONS_HELP = `gardener <repositories|tasks|runs|run show|task enable|task disable|repository enable|repository disable>

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    Optional repository filter or required control target
  --task <id>                  Task identity for task enable/disable
  --run <id>                   Run identity for run show
  --limit <1-100>              Maximum runs to list
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
`;

const INIT_HELP = `gardener init

Creates a local, secret-free Gardener project. This command never mutates Cloudflare or GitHub.

Options:
  --demos                      Add the bug-intake and documentation-helper demo tasks
  --repository-root <path>     Customer repository (defaults to current directory)
`;

const BUILD_HELP = `gardener build

Compiles .gardener/tasks/*/TASK.md into canonical TaskBundleV1 records, writes the
reproducible lock file, and generates one GitHub caller workflow per task.

Options:
  --repository-root <path>     Customer repository (defaults to current directory)
`;

const DEPLOY_HELP = `gardener deploy

Provision or resume one headless Actions-native Gardener deployment.

Options:
  --workspace <name>           Stable installation name
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
`;

const UPGRADE_HELP = `gardener upgrade

Upgrade the runtime and one repository's pinned GitHub bridge release, rebuild its workflows,
re-enroll it, and verify the installation. Existing projects never upgrade implicitly through the up command.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    Connected GitHub repository to upgrade
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
`;

const ROLLBACK_HELP = `gardener rollback

Redeploy a trusted prior source checkout only when its digest matches recorded deployment history.
Database migrations remain forward-only; rollback restores code, not schema.

Options:
  --workspace <name>           Existing Gardener installation
  --source-root <path>         Explicit trusted prior Gardener source checkout (required)
  --confirm <source-digest>    Historical deployment digest to restore (required)
`;

const CONNECT_HELP = `gardener connect

Enroll a repository, upload its compiled bundles, and set its non-secret runtime URL variable.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    GitHub repository to enroll
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
`;

const QUALIFY_HELP = `gardener qualify

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
`;

const DOWN_HELP = `gardener down

Create or execute a manifest-bound teardown intent for the recorded Cloudflare resources.

Options:
  --workspace <name>           Existing Gardener installation
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
  --execute                    Execute a previously written teardown intent
  --confirm <intent-digest>    Exact digest returned by the planning invocation
`;

const UP_HELP = `gardener up

Scaffold, compile, deploy, connect, and verify a reproducible Gardener installation.

Options:
  --workspace <name>           Stable installation name
  --repository <owner/name>    GitHub repository to enroll
  --demos                      Add the two bounded demo tasks
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
`;

async function main(argv: string[]): Promise<void> {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = normalized;
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }
  const operationCommand = command === "task" || command === "repository" || command === "repositories" || command === "tasks" || command === "runs" || command === "run";
  if (operationCommand && (rest.includes("help") || rest.includes("--help"))) {
    console.log(OPERATIONS_HELP);
    return;
  }
  if (operationCommand) {
    await operate(command, rest);
    return;
  }
  if (rest[0] === "help" || rest[0] === "--help") {
    const help = command === "init" ? INIT_HELP
      : command === "build" ? BUILD_HELP
      : command === "deploy" || command === "doctor" ? DEPLOY_HELP
      : command === "upgrade" ? UPGRADE_HELP
      : command === "rollback" ? ROLLBACK_HELP
      : command === "connect" ? CONNECT_HELP
      : command === "qualify" ? QUALIFY_HELP
      : command === "down" ? DOWN_HELP
      : command === "up" ? UP_HELP
      : null;
    if (!help) throw new Error(`Unknown Gardener command: ${command}`);
    console.log(help);
    return;
  }
  const { positional, flags } = parse(rest);
  if (positional.length) throw new Error(`gardener ${command} does not accept positional arguments`);
  const repositoryRoot = stringFlag(flags, "repository-root") ?? process.cwd();
  const sourceRoot = stringFlag(flags, "source-root") ?? defaultSourceRoot();

  if (command === "init") {
    printInit(await initializeProject({
      repositoryRoot,
      demos: flags.get("demos") === true,
    }));
    return;
  }
  if (command === "build") {
    printBuild(await buildProject({ repositoryRoot }));
    return;
  }
  if (command === "deploy") {
    const manifest = await deployActions({
      workspace: requiredStringFlag(flags, "workspace"),
      sourceRoot,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (command === "upgrade") {
    const workspace = requiredStringFlag(flags, "workspace");
    const repository = requiredStringFlag(flags, "repository");
    const runtime = await upgradeActions({ workspace, sourceRoot });
    try {
      const project = await upgradeProjectRelease({ repositoryRoot });
      const build = await buildProject({ repositoryRoot });
      const connection = await connectActions({ workspace, repository, repositoryRoot, sourceRoot });
      const doctor = await doctorActions(workspace, sourceRoot);
      warnStaleBridgeRepositories(doctor);
      console.log(JSON.stringify({ runtime, project, build, connection, doctor }, null, 2));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown repository error";
      throw new Error(
        `The runtime upgrade completed, but the repository bridge upgrade did not: ${detail}. Fix the repository error, then rerun the identical gardener upgrade command; every step is resumable.`,
        { cause: error },
      );
    }
    return;
  }
  if (command === "rollback") {
    console.log(JSON.stringify(await rollbackActions({
      workspace: requiredStringFlag(flags, "workspace"),
      sourceRoot: requiredStringFlag(flags, "source-root"),
      confirm: requiredStringFlag(flags, "confirm"),
    }), null, 2));
    return;
  }
  if (command === "connect") {
    console.log(JSON.stringify(await connectActions({
      workspace: requiredStringFlag(flags, "workspace"),
      repository: requiredStringFlag(flags, "repository"),
      repositoryRoot,
      sourceRoot,
    }), null, 2));
    return;
  }
  if (command === "doctor") {
    const doctor = await doctorActions(requiredStringFlag(flags, "workspace"), sourceRoot);
    warnStaleBridgeRepositories(doctor);
    console.log(JSON.stringify(doctor, null, 2));
    return;
  }
  if (command === "qualify") {
    console.log(JSON.stringify(await qualifyActions({
      workspace: requiredStringFlag(flags, "workspace"),
      repository: requiredStringFlag(flags, "repository"),
      repositoryRoot,
      sourceRoot,
      drills: flags.get("drills") === true,
      drillsOnly: flags.get("drills-only") === true,
    }), null, 2));
    return;
  }
  if (command === "down") {
    const confirm = stringFlag(flags, "confirm");
    console.log(JSON.stringify(await destroyActions({
      workspace: requiredStringFlag(flags, "workspace"),
      sourceRoot,
      execute: flags.get("execute") === true,
      ...(confirm ? { confirm } : {}),
    }), null, 2));
    return;
  }
  if (command === "up") {
    const workspace = requiredStringFlag(flags, "workspace");
    const repository = requiredStringFlag(flags, "repository");
    printInit(await initializeProject({ repositoryRoot, demos: flags.get("demos") === true }));
    printBuild(await buildProject({ repositoryRoot }));
    await deployActions({ workspace, sourceRoot });
    console.log(JSON.stringify(await connectActions({
      workspace,
      repository,
      repositoryRoot,
      sourceRoot,
    }), null, 2));
    const doctor = await doctorActions(workspace, sourceRoot);
    warnStaleBridgeRepositories(doctor);
    console.log(JSON.stringify(doctor, null, 2));
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

async function operate(command: string, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const actionCommand = command === "task" || command === "repository";
  const runShow = command === "run";
  const parsed = parse(actionCommand || runShow ? rest : args);
  const repositoryRoot = stringFlag(parsed.flags, "repository-root") ?? process.cwd();
  const sourceRoot = stringFlag(parsed.flags, "source-root") ?? defaultSourceRoot();
  const workspace = requiredStringFlag(parsed.flags, "workspace");
  const repository = stringFlag(parsed.flags, "repository");

  if (command === "task") {
    if (subcommand !== "enable" && subcommand !== "disable") throw new Error("Usage: gardener task <enable|disable> --task <id>");
    if (!repository) throw new Error("--repository is required");
    console.log(JSON.stringify(await setTaskEnabled({
      workspace,
      repository,
      taskId: requiredStringFlag(parsed.flags, "task"),
      repositoryRoot,
      sourceRoot,
      enabled: subcommand === "enable",
    }), null, 2));
    return;
  }
  if (command === "repository") {
    if (subcommand !== "enable" && subcommand !== "disable") throw new Error("Usage: gardener repository <enable|disable>");
    if (!repository) throw new Error("--repository is required");
    console.log(JSON.stringify(await setRepositoryEnabled({
      workspace,
      repository,
      sourceRoot,
      enabled: subcommand === "enable",
    }), null, 2));
    return;
  }
  if (command === "repositories") {
    if (parsed.positional.length) throw new Error("gardener repositories does not accept positional arguments");
    console.log(JSON.stringify(await listActionsRepositories({ workspace, sourceRoot }), null, 2));
    return;
  }
  if (command === "tasks") {
    if (parsed.positional.length) throw new Error("gardener tasks does not accept positional arguments");
    console.log(JSON.stringify(await listActionsTasks({
      workspace,
      ...(repository ? { repository } : {}),
      sourceRoot,
    }), null, 2));
    return;
  }
  if (command === "runs") {
    if (parsed.positional.length) throw new Error("gardener runs does not accept positional arguments");
    const limitValue = stringFlag(parsed.flags, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new Error("--limit must be an integer from 1 to 100");
    }
    console.log(JSON.stringify(await listActionsRuns({
      workspace,
      ...(repository ? { repository } : {}),
      sourceRoot,
      ...(limit === undefined ? {} : { limit }),
    }), null, 2));
    return;
  }
  if (command === "run") {
    if (subcommand !== "show" || parsed.positional.length) throw new Error("Usage: gardener run show --run <id>");
    console.log(JSON.stringify(await showActionsRun({
      workspace,
      runId: requiredStringFlag(parsed.flags, "run"),
      sourceRoot,
    }), null, 2));
    return;
  }
  throw new Error(`Unknown Gardener operation: ${command}`);
}

function warnStaleBridgeRepositories(doctor: Awaited<ReturnType<typeof doctorActions>>): void {
  if (doctor.staleBridgeRepositories > 0) {
    console.error(terminal.caution(
      `${doctor.staleBridgeRepositories} enabled repository enrollment(s) differ from this CLI's bridge release; run gardener upgrade for each repository.`,
    ));
  }
}

function printInit(result: { created: string[]; preserved: string[] }): void {
  for (const path of result.created) console.log(`created ${path}`);
  for (const path of result.preserved) console.log(`preserved ${path}`);
}

function printBuild(result: {
  lockPath: string;
  tasks: Array<{ taskId: string; bundleHash: string; workflow: string }>;
}): void {
  console.log(`wrote ${result.lockPath}`);
  for (const task of result.tasks) console.log(`${task.taskId} ${task.bundleHash} ${task.workflow}`);
}

function requiredStringFlag(flags: Map<string, string | true>, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(terminal.error(error instanceof Error ? error.message : "Gardener CLI failed"));
  process.exitCode = 1;
});
