import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(repositoryRoot, "apps/gardener/dist/gardener_actions_v1_runtime");
const entry = await readFile(join(output, "index.js"), "utf8");
for (const required of ["TaskRunnerSession", "FlueGardenerTaskHarnessAgent", "GardenerRunnerIngressEntrypoint"]) {
  if (!entry.includes(required)) throw new Error(`Actions runtime is missing ${required}`);
}
for (const forbidden of [
  "ComputerWorkspace",
  "GardenerGitHubEntrypoint",
  "GardenerFlueAgent",
  "github-gateway/v1",
  "mcp_consent_states",
  "GITHUB_CLIENT_SECRET",
]) {
  if (entry.includes(forbidden)) throw new Error(`Actions runtime leaked legacy surface ${forbidden}`);
}
for (const forbidden of ["0001_initial", "0004_agent_native_reset"]) {
  if (entry.includes(forbidden)) {
    throw new Error(`Actions runtime imports legacy migration asset ${forbidden}`);
  }
}
