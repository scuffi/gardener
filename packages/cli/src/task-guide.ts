import { readFile } from "node:fs/promises";
import guide from "./task-guide.md";

/**
 * The agent skill for writing tasks, kept next to them so a coding agent
 * working in the repository finds it. `init` creates it and `generate`
 * rewrites it, so it always describes the CLI that validates the tasks.
 */
export const TASK_GUIDE_PATH = ".gardener/SKILL.md";

export async function renderTaskGuide(): Promise<string> {
  const value = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error("Gardener CLI package.json has no version");
  return guide.replaceAll("{{version}}", value.version);
}
