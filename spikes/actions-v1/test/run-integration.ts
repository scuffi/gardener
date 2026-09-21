import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const port = await availablePort();
const worker = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(port)], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, CI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let workerOutput = "";
worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });

try {
  await waitUntilReady();
  await runLiveClient();
  await runBundledAction();
  console.log(`Cap'n Web Worker and bundled Action integration passed on port ${port}`);
} finally {
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => worker.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function runLiveClient(): Promise<void> {
  const result = await run("pnpm", ["exec", "tsx", "test/live-client.ts"], {
    ...process.env,
    GARDENER_SPIKE_URL: `http://127.0.0.1:${port}`,
  }, new URL("..", import.meta.url));
  if (result.code !== 0) throw new Error(`Live client exited with ${result.code}:\n${result.output}`);
  const resultLine = result.output.trim().split("\n").at(-1);
  const parsed = JSON.parse(resultLine ?? "null") as { ok?: boolean } | null;
  if (parsed?.ok !== true) throw new Error(`Live client did not report success:\n${result.output}`);
}

async function runBundledAction(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "gardener-action-integration-"));
  const outputPath = path.join(directory, "github-output.txt");
  await writeFile(outputPath, "");
  const token = unsignedOidcToken({
    repository_id: "1318443351",
    repository_owner_id: "45369682",
    run_id: String(Date.now()),
    run_attempt: "1",
    workflow_ref: "scuffi/flue/.github/workflows/gardener.yml@refs/heads/main",
    job_workflow_ref: "scuffi/gardener/.github/workflows/run.yml@0123456789012345678901234567890123456789",
    event_name: "workflow_dispatch",
    ref: "refs/heads/main",
    runner_environment: "github-hosted",
    sha: "a".repeat(40),
  });
  const oidcPort = await availablePort();
  const oidcServer = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer local-request-token") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ value: token }));
  });
  await new Promise<void>((resolve, reject) => {
    oidcServer.once("error", reject);
    oidcServer.listen(oidcPort, "127.0.0.1", resolve);
  });
  try {
    const action = await run("node", ["../../actions/runner/dist/index.cjs"], {
      ...process.env,
      "INPUT_HARNESS-URL": `http://127.0.0.1:${port}`,
      "INPUT_TASK-BUNDLE-HASH": "b".repeat(64),
      "INPUT_MAX-RECONNECTS": "1",
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${oidcPort}/token?api-version=1`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "local-request-token",
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: outputPath,
      GITHUB_WORKSPACE: directory,
    }, new URL("..", import.meta.url));
    if (action.code !== 0) throw new Error(`Bundled Action exited with ${action.code}:\n${action.output}`);
    const outputs = await readFile(outputPath, "utf8");
    if (!outputs.includes("status<<") || !outputs.includes("completed") || !outputs.includes("github-actions-capnweb-ok")) {
      throw new Error(`Bundled Action did not produce successful outputs:\n${outputs}\n${action.output}`);
    }
  } finally {
    oidcServer.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: URL): Promise<{ code: number | null; output: string }> {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, output };
}

function unsignedOidcToken(claims: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.local`;
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (/Ready on http:\/\//.test(workerOutput)) return;
    if (worker.exitCode !== null) throw new Error(`Wrangler exited before readiness:\n${workerOutput}`);
    if (Date.now() >= deadline) throw new Error(`Wrangler did not become ready:\n${workerOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  const selectedPort = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return selectedPort;
}
