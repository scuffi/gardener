import { appendFile, readFile } from "node:fs/promises";
import type { SyncRequestV1 } from "@gardener/contracts";
import { planProject, staleProjectFiles } from "./project.js";

/**
 * The pinned sync bridge (`bridges/github/sync`). After a push to the default
 * branch it compiles the committed tasks with this release's compiler, refuses
 * to continue if the committed Gardener files differ from that output, and
 * sends the tasks to the runtime, which then runs exactly these. In check mode,
 * for pull requests, it stops after the comparison: no token, no runtime call.
 */
const TIMEOUT_MS = 30_000;
/** Delays before each retry. Runners occasionally fail to connect at all. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

async function main(): Promise<void> {
  // No default: an omitted mode fails, rather than silently syncing or not.
  const mode = process.env.INPUT_MODE?.trim();
  if (mode !== "sync" && mode !== "check") {
    fail(`Expected mode sync or check, got ${JSON.stringify(mode || null)}`);
    return;
  }
  const root = required("GITHUB_WORKSPACE");
  const plan = await planProject({ repositoryRoot: root });

  // The runtime only trusts its own release's workflows, so a lock pinned to
  // another repository could never sync. Say so on the pull request.
  const bridgeRepository = required("GITHUB_ACTION_REPOSITORY");
  const pinnedRepository = plan.workflowRef.split("/.github/workflows/")[0] ?? "";
  if (pinnedRepository.toLowerCase() !== bridgeRepository.toLowerCase()) {
    fail(
      `.gardener/gardener.json pins ${plan.workflowRef}, which is not a ${bridgeRepository} release. `
      + "Gardener only runs its own releases; restore the pinned release and run `gardener generate`.",
    );
    return;
  }

  const stale = await staleProjectFiles(plan);
  if (stale.length > 0) {
    fail(
      `The committed Gardener files don't match the tasks: ${stale.join(", ")}. `
      + "Run `gardener generate` with this repository's Gardener release and commit the result. "
      + (mode === "check"
        ? "Merged as is, the sync would refuse it and the previous tasks would keep running."
        : "Until then the previously enrolled tasks keep running."),
    );
    return;
  }
  if (mode === "check") {
    console.log(`The Gardener files are up to date: ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}.`);
    for (const task of plan.tasks) console.log(`  ${task.taskId}`);
    return;
  }
  const runtimeUrl = runtimeOrigin(process.env["INPUT_RUNTIME-URL"]?.trim() ?? "");

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
  const body = JSON.stringify(request);
  const { response, attempt } = await withRetries("Sending the tasks to Gardener", () => fetch(`${runtimeUrl}/v1/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "gardener-sync" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  const result = await response.json().catch(() => null) as
    | { ok?: boolean; error?: unknown; tasks?: Array<{ taskId: string; bundleHash: string }> }
    | null;
  // An earlier attempt reached the runtime, and only its reply was lost.
  if (attempt > 1 && response.status === 409 && typeof result?.error === "string" && /already synced/.test(result.error)) {
    console.log("Gardener had already applied this sync; its earlier reply was lost.");
    return;
  }
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
  const { response } = await withRetries("Requesting a GitHub OIDC token", () => fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error(`Requesting a GitHub OIDC token failed (${response.status})`);
  const value = (await response.json() as { value?: unknown }).value;
  if (typeof value !== "string" || value.length === 0) throw new Error("GitHub returned no OIDC token");
  console.log(`::add-mask::${value}`);
  return value;
}

/**
 * Retries a request that failed to connect, timed out, or got a 5xx or 429,
 * logging the underlying cause each time. Other responses are returned as is.
 */
export async function withRetries(
  label: string,
  request: () => Promise<Response>,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<{ response: Response; attempt: number }> {
  for (let attempt = 1; ; attempt += 1) {
    let failure: string;
    try {
      const response = await request();
      if (response.status < 500 && response.status !== 429) return { response, attempt };
      if (attempt > delays.length) return { response, attempt };
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = describeError(error);
      if (attempt > delays.length) throw new Error(`${label} failed: ${failure}`, { cause: error });
    }
    console.log(`${label} failed (attempt ${attempt}): ${failure}; retrying`);
    await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
  }
}

/** A fetch error with its cause, which Node otherwise hides behind "fetch failed". */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = cause && typeof cause === "object"
    ? [cause.code, cause.message].filter((part) => typeof part === "string" && part.length > 0).join(": ")
    : "";
  return detail ? `${error.message} (${detail})` : error.message;
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

// Runs when the CommonJS bundle is the entry point, as the action runs it.
// Imported from the ESM tests, `require` doesn't exist and nothing runs.
if (typeof require !== "undefined" && require.main === module) {
  main().catch((error: unknown) => fail(describeError(error)));
}
