import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(repositoryRoot, "apps/gardener/dist/gardener_runtime");
const entry = await readFile(join(output, "index.js"), "utf8");
const exportsBlock = [...entry.matchAll(/export\s*\{([^}]+)\}/g)].at(-1)?.[1] ?? "";
for (const required of ["TaskRunnerSession", "FlueGardenerTaskHarnessAgent"]) {
  if (!exportsBlock.includes(required)) throw new Error(`Actions runtime does not export ${required}`);
}
if (!exportsBlock.includes("default") || !entry.includes('service: "gardener-runtime"')) {
  throw new Error("Actions runtime is missing its narrow public health handler");
}
for (const forbidden of [
  "ComputerWorkspace",
  "GardenerGitHubEntrypoint",
  "GardenerRunnerIngressEntrypoint",
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
