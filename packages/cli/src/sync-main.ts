import { appendFile, readFile } from "node:fs/promises";
import type { SyncRequestV1 } from "@gardener/contracts";
import { planProject, staleProjectFiles } from "./project.js";

/**
 * The pinned sync bridge (`bridges/github/sync`). After a push to the default
 * branch it compiles the committed tasks with this release's compiler, refuses
 * to continue if the committed Gardener files differ from that output, and
 * sends the tasks to the runtime, which then runs exactly these.
 */
const TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const runtimeUrl = runtimeOrigin(process.env["INPUT_RUNTIME-URL"]?.trim() ?? "");
  const root = required("GITHUB_WORKSPACE");
  const plan = await planProject({ repositoryRoot: root });

  const stale = await staleProjectFiles(plan);
  if (stale.length > 0) {
    fail(
      `The committed Gardener files don't match the tasks: ${stale.join(", ")}. `
      + "Run `gardener generate` with this repository's Gardener release and commit the result. "
      + "Until then the previously enrolled tasks keep running.",
    );
    return;
  }

  const event = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as { repository?: { default_branch?: unknown } };
  const defaultBranch = event.repository?.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    fail("The event does not name the repository's default branch");
    return;
  }
  const request: SyncRequestV1 = {
    schemaVersion: "gardener.sync-request/v1",
    defaultBranch,
    workflowRef: plan.workflowRef,
    tasks: plan.tasks.map(({ taskId, source, bundle }) => ({ taskId, source, bundle })),
  };
  const token = await oidcToken(runtimeUrl);
  const response = await fetch(`${runtimeUrl}/v1/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "gardener-sync" },
    body: JSON.stringify(request),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const result = await response.json().catch(() => null) as
    | { ok?: boolean; error?: unknown; tasks?: Array<{ taskId: string; bundleHash: string }> }
    | null;
  if (!response.ok || result?.ok !== true) {
    fail(`Gardener refused the sync (${response.status}): ${typeof result?.error === "string" ? result.error : "no detail"}`);
    return;
  }
  const tasks = result.tasks ?? [];
  console.log(`Gardener now runs ${tasks.length} task${tasks.length === 1 ? "" : "s"} from this commit:`);
  for (const task of tasks) console.log(`  ${task.taskId}  sha256:${task.bundleHash}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await appendFile(summary, [
      "### Gardener tasks enrolled",
      "",
      tasks.length === 0 ? "No tasks: every task is now stopped." : "| Task | Bundle |\n| --- | --- |",
      ...tasks.map((task) => `| \`${task.taskId}\` | \`${task.bundleHash.slice(0, 12)}\` |`),
      "",
    ].join("\n"));
  }
}

function runtimeOrigin(value: string): string {
  if (!value) {
    fail("GARDENER_RUNTIME_URL is not set for this repository; run gardener connect once");
    process.exit();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("runtime-url is not a URL");
    process.exit();
  }
  if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) {
    fail("runtime-url must be an https origin");
    process.exit();
  }
  return url.origin;
}

/** A GitHub OIDC token for the runtime, from the Actions token service. */
async function oidcToken(audience: string): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("GitHub Actions OIDC is unavailable; the sync job needs id-token: write");
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Requesting a GitHub OIDC token failed (${response.status})`);
  const value = (await response.json() as { value?: unknown }).value;
  if (typeof value !== "string" || value.length === 0) throw new Error("GitHub returned no OIDC token");
  console.log(`::add-mask::${value}`);
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function fail(message: string): void {
  console.log(`::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
