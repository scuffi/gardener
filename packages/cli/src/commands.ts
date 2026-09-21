import { spawnSync } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; quiet?: boolean; allowFailure?: boolean; timeoutMs?: number },
): CommandResult {
  if (!options.quiet) console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!options.quiet) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(`Command timed out: ${command} ${args.join(" ")}`);
    }
    throw result.error;
  }
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    if (options.quiet) {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
    throw new Error(`Command failed (${result.status ?? "unknown"}): ${command} ${args.join(" ")}`);
  }
  return { stdout, stderr, status };
}

export function workerOrigin(output: CommandResult, workerName: string): string {
  const combined = `${output.stdout}\n${output.stderr}`;
  const urls = combined.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/g) ?? [];
  const expected = urls.find((url) => new URL(url).hostname.startsWith(`${workerName}.`));
  const selected = expected ?? urls.at(-1);
  if (!selected) throw new Error(`Wrangler did not report a workers.dev URL for ${workerName}`);
  return selected.replace(/\/$/, "");
}

export function wrangler(
  repositoryRoot: string,
  workingDirectory: string,
  args: string[],
  input?: string,
  options?: { quiet?: boolean },
): CommandResult {
  return runCommand("pnpm", ["exec", "wrangler", ...args], {
    cwd: `${repositoryRoot}/${workingDirectory}`,
    ...(input === undefined ? {} : { input }),
    ...(options?.quiet === undefined ? {} : { quiet: options.quiet }),
  });
}

export function uploadSecret(
  repositoryRoot: string,
  applicationDirectory: string,
  name: string,
  value: string,
  config?: string,
  quiet = false,
): void {
  if (!quiet) console.log(`Uploading ${name} directly to the GitHub Gateway.`);
  wrangler(
    repositoryRoot,
    applicationDirectory,
    ["secret", "put", name, ...(config ? ["--config", config] : [])],
    `${value}\n`,
    { quiet },
  );
}
