#!/usr/bin/env node
import { connectActions, deployActions, destroyActions, doctorActions } from "./actions-installation.js";
import { qualifyActions } from "./actions-qualify.js";
import { parse } from "./args.js";
import { buildProject, initializeProject } from "./project.js";
import { terminal } from "./terminal.js";

const HELP = `gardener <command>

Commands:
  init                         Create a local .gardener project
  build                        Compile TASK.md files and generate caller workflows
  deploy                       Provision the headless Actions-native Cloudflare runtime
  connect                      Enroll a GitHub repository and its compiled task bundles
  up                           Init, build, deploy, connect, and verify
  doctor                       Verify an existing Actions-native installation
  qualify                      Run both demo workflows and verify exact receipts
  down                         Preview or execute manifest-guarded teardown

Run \`gardener <command> --help\` for command options.
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
  --source-root <path>         Trusted Gardener source checkout (defaults to current directory)
`;

const CONNECT_HELP = `gardener connect

Enroll a repository, upload its compiled bundles, and set its non-secret ingress variable.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    GitHub repository to enroll
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted Gardener source checkout (defaults to current directory)
`;

const QUALIFY_HELP = `gardener qualify

Create one disposable issue per compiled task, wait for both generated workflows, and verify the
unique GitHub comment and D1 receipt for each bundle.

Options:
  --workspace <name>           Existing Gardener installation
  --repository <owner/name>    Connected GitHub repository
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted Gardener source checkout (defaults to current directory)
`;

const DOWN_HELP = `gardener down

Preview or execute deletion of only the Cloudflare resources recorded in the installation manifest.

Options:
  --workspace <name>           Existing Gardener installation
  --source-root <path>         Trusted Gardener source checkout (defaults to current directory)
  --execute                    Perform deletion (default is a dry run)
  --confirm <workspace>        Exact workspace confirmation required with --execute
`;

const UP_HELP = `gardener up

Scaffold, compile, deploy, connect, and verify a reproducible Gardener installation.

Options:
  --workspace <name>           Stable installation name
  --repository <owner/name>    GitHub repository to enroll
  --demos                      Add the two bounded demo tasks
  --repository-root <path>     Customer repository (defaults to current directory)
  --source-root <path>         Trusted Gardener source checkout (defaults to current directory)
`;

async function main(argv: string[]): Promise<void> {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = normalized;
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }
  if (rest[0] === "help" || rest[0] === "--help") {
    const help = command === "init" ? INIT_HELP
      : command === "build" ? BUILD_HELP
      : command === "deploy" || command === "doctor" ? DEPLOY_HELP
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
  const sourceRoot = stringFlag(flags, "source-root") ?? process.cwd();

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
    console.log(JSON.stringify(await doctorActions(requiredStringFlag(flags, "workspace"), sourceRoot), null, 2));
    return;
  }
  if (command === "qualify") {
    console.log(JSON.stringify(await qualifyActions({
      workspace: requiredStringFlag(flags, "workspace"),
      repository: requiredStringFlag(flags, "repository"),
      repositoryRoot,
      sourceRoot,
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
    console.log(JSON.stringify(await doctorActions(workspace, sourceRoot), null, 2));
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
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
