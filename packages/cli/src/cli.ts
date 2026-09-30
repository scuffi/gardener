#!/usr/bin/env node
import {
  AI_GATEWAY_TOKEN,
  cliVersion,
  connectActions,
  deployActions,
  doctorActions,
  parseAiGateway,
  upgradeActions,
} from "./actions-installation.js";
import {
  listActionsRepositories,
  listActionsRuns,
  listActionsTasks,
  setRepositoryEnabled,
  showActionsRun,
} from "./actions-operations.js";
import { qualifyActions } from "./actions-qualify.js";
import { parse } from "./args.js";
import { buildProject, initializeProject, pinCliScripts, requireProject, upgradeProjectRelease } from "./project.js";
import { defaultSourceRoot } from "./distribution.js";
import { terminal } from "./terminal.js";

const HELP = `gardener <command>

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

Run \`gardener <command> --help\` for command options.
`;

/**
 * Renamed commands fail with a pointer to the new name rather than working
 * silently, so scripts are fixed once.
 */
const RENAMED: Record<string, string> = { build: "generate", up: "yolo", qualify: "debug" };

const OPERATIONS_HELP = `gardener <repositories|tasks|runs|runs view|repository disable|repository enable>

repository disable stops every task in a repository straight away, whatever is on its default
branch; repository enable resumes them.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    Optional repository filter or required control target
  --run <id>                   Run identity for runs view
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

const GENERATE_HELP = `gardener generate

Compiles .gardener/tasks/*/TASK.md into canonical TaskBundleV1 records, writes the
reproducible lock file, and generates one GitHub caller workflow per task.

Options:
  --repository-root <path>     Customer repository (defaults to current directory)
`;

const DEPLOY_HELP = `gardener deploy

Deploy or update the Gardener runtime on Cloudflare. Existing gardener-<workspace>
resources on the account are adopted; a runtime from a newer CLI is never replaced.

Options:
  --workspace <name>           Stable installation name
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
  --ai-gateway <account>/<id>  Send non-Workers-AI models to this AI Gateway, which may be in
                               another account; its token comes from GARDENER_AI_GATEWAY_TOKEN.
                               "off" removes it. Omitted keeps the current gateway
  --ai-gateway-project <name>  Project sent as cf-aig-metadata on every gateway request
`;

const UPGRADE_HELP = `gardener upgrade

Upgrade an existing runtime, move one repository's files to this release's pinned workflows,
regenerate them, and verify the installation. Commit and push the result: the sync workflow enrols
it when it reaches the default branch. Existing projects never upgrade implicitly through the yolo
command.

Options:
  --workspace <name>           Existing Gardener installation
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
`;

const CONNECT_HELP = `gardener connect

Connect a repository once: enroll it, upload its compiled bundles, set its non-secret runtime
URL variable, and start the sync workflow on its default branch if it is there yet. Bundles not in
this checkout are disabled until that sync, so run it from the default branch.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    GitHub repository to enroll
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted source checkout override (packaged runtime by default)
`;

const DEBUG_HELP = `gardener debug

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

const YOLO_HELP = `gardener yolo

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
  const renamed = RENAMED[command];
  if (renamed) throw new Error(`gardener ${command} was renamed to gardener ${renamed}`);
  if (command === "run") throw new Error("gardener run show was renamed to gardener runs view");
  if (command === "task") {
    throw new Error("gardener task enable|disable was removed: the tasks on the default branch are the live ones. To stop a task, delete it or set draft: true; to stop everything, use gardener repository disable");
  }
  const operationCommand = command === "repository" || command === "repositories" || command === "tasks" || command === "runs";
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
      : command === "generate" ? GENERATE_HELP
      : command === "deploy" || command === "doctor" ? DEPLOY_HELP
      : command === "upgrade" ? UPGRADE_HELP
      : command === "connect" ? CONNECT_HELP
      : command === "debug" ? DEBUG_HELP
      : command === "yolo" ? YOLO_HELP
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
  if (command === "generate") {
    printBuild(await buildProject({ repositoryRoot }));
    return;
  }
  if (command === "deploy") {
    const gateway = stringFlag(flags, "ai-gateway");
    const project = stringFlag(flags, "ai-gateway-project");
    if (project !== undefined && gateway === undefined) throw new Error("--ai-gateway-project needs --ai-gateway");
    const installation = await deployActions({
      workspace: requiredStringFlag(flags, "workspace"),
      sourceRoot,
      ...(gateway === undefined ? {} : { aiGateway: parseAiGateway(gateway, project) }),
      ...gatewayToken(),
    });
    console.log(JSON.stringify(installation, null, 2));
    return;
  }
  if (command === "upgrade") {
    const workspace = requiredStringFlag(flags, "workspace");
    // Before anything remote, so a wrong directory changes nothing.
    await requireProject(repositoryRoot);
    const runtime = await upgradeActions({ workspace, sourceRoot, ...gatewayToken() });
    try {
      const project = await upgradeProjectRelease({ repositoryRoot });
      const build = await buildProject({ repositoryRoot });
      printBuildWarnings(build);
      const scripts = await pinCliScripts({ repositoryRoot, version: await cliVersion() });
      // Not connected here: the enrollment moves to the new release when the
      // regenerated files reach the default branch, so runs keep working until then.
      const doctor = await doctorActions(workspace, sourceRoot);
      warnDoctorFindings(doctor);
      console.log(JSON.stringify({ runtime, project, build, scripts, doctor }, null, 2));
      console.error(`Commit and push .gardener/ and .github/workflows/${scripts.length > 0 ? " and package.json" : ""}. When they reach the default branch, the Gardener sync workflow enrols them.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown repository error";
      throw new Error(
        `The runtime deployment completed, but the repository bridge upgrade did not: ${detail}. Fix the repository error, then rerun the identical gardener upgrade command; every step is resumable.`,
        { cause: error },
      );
    }
    return;
  }
  if (command === "connect") {
    const connected = await connectActions({
      workspace: requiredStringFlag(flags, "workspace"),
      repository: requiredStringFlag(flags, "repository"),
      repositoryRoot,
      sourceRoot,
    });
    console.log(JSON.stringify(connected, null, 2));
    console.error(connected.syncStarted
      ? "Started the Gardener sync workflow on the default branch; it enrols the tasks there."
      : "Connected. Commit and push .gardener/ and .github/workflows/: when they reach the default branch, the sync workflow enrols them.");
    return;
  }
  if (command === "doctor") {
    const doctor = await doctorActions(requiredStringFlag(flags, "workspace"), sourceRoot);
    warnDoctorFindings(doctor);
    console.log(JSON.stringify(doctor, null, 2));
    return;
  }
  if (command === "debug") {
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
  if (command === "yolo") {
    const workspace = requiredStringFlag(flags, "workspace");
    const repository = requiredStringFlag(flags, "repository");
    printInit(await initializeProject({ repositoryRoot, demos: flags.get("demos") === true }));
    printBuild(await buildProject({ repositoryRoot }));
    await deployActions({ workspace, sourceRoot, ...gatewayToken() });
    console.log(JSON.stringify(await connectActions({
      workspace,
      repository,
      repositoryRoot,
      sourceRoot,
    }), null, 2));
    const doctor = await doctorActions(workspace, sourceRoot);
    warnDoctorFindings(doctor);
    console.log(JSON.stringify(doctor, null, 2));
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

async function operate(command: string, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const actionCommand = command === "repository";
  const runShow = command === "runs" && subcommand === "view";
  const parsed = parse(actionCommand || runShow ? rest : args);
  const repositoryRoot = stringFlag(parsed.flags, "repository-root") ?? process.cwd();
  const sourceRoot = stringFlag(parsed.flags, "source-root") ?? defaultSourceRoot();
  const workspace = requiredStringFlag(parsed.flags, "workspace");
  const repository = stringFlag(parsed.flags, "repository");

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
  if (runShow) {
    if (parsed.positional.length) throw new Error("Usage: gardener runs view --run <id>");
    console.log(JSON.stringify(await showActionsRun({
      workspace,
      runId: requiredStringFlag(parsed.flags, "run"),
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
  throw new Error(`Unknown Gardener operation: ${command}`);
}

function warnDoctorFindings(doctor: Awaited<ReturnType<typeof doctorActions>>): void {
  if (doctor.staleBridgeRepositories > 0) {
    console.error(terminal.caution(
      `${doctor.staleBridgeRepositories} enabled repository enrollment(s) differ from this CLI's bridge release; run gardener upgrade for each repository.`,
    ));
  }
  for (const warning of doctor.pullRequestPermissionWarnings) console.error(terminal.caution(warning.message));
}

function printInit(result: { created: string[]; preserved: string[] }): void {
  for (const path of result.created) console.log(`created ${path}`);
  for (const path of result.preserved) console.log(`preserved ${path}`);
}

function printBuild(result: {
  lockPath: string;
  tasks: Array<{ taskId: string; bundleHash: string; workflow: string }>;
  warnings: string[];
}): void {
  console.log(`wrote ${result.lockPath}`);
  for (const task of result.tasks) console.log(`${task.taskId} ${task.bundleHash} ${task.workflow}`);
  printBuildWarnings(result);
}

/**
 * Surfaces every build warning on stderr. A capability as consequential as
 * unrestricted runner egress must be visible at the moment it is compiled in,
 * not only to whoever later reads the task source.
 */
function printBuildWarnings(result: { warnings: string[] }): void {
  for (const warning of result.warnings) terminal.warn(warning);
}

/** The AI Gateway token from the environment, for commands that deploy the runtime. */
function gatewayToken(): { aiGatewayToken?: string } {
  const token = process.env[AI_GATEWAY_TOKEN];
  return token ? { aiGatewayToken: token } : {};
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
