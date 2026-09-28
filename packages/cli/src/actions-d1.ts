import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrangler } from "./commands.js";

let isolated: string | undefined;

/**
 * A private directory holding its own minimal wrangler config. Wrangler looks
 * for a config in the working directory and then its parents, and a config's
 * `d1_databases` entry overrides name lookup. Having our own config nearest
 * means neither a repository's config nor one planted in a shared parent such
 * as /tmp can redirect a name to another database or account.
 */
export function isolatedWranglerDirectory(): string {
  if (!isolated) {
    const directory = mkdtempSync(join(tmpdir(), "gardener-wrangler-"));
    writeFileSync(join(directory, "wrangler.json"), `${JSON.stringify({ name: "gardener-cli" })}\n`, { mode: 0o600 });
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    isolated = directory;
  }
  return isolated;
}

/** Runs D1 commands against a Gardener database, resolved by name through the selected account. */
export function executeD1(database: string, command: string): void {
  d1(database, ["--command", command]);
}

export function queryD1(database: string, command: string): Array<Record<string, unknown>> {
  return d1Rows(d1(database, ["--json", "--command", command]).stdout);
}

/** Like queryD1, but returns null when the queried table does not exist yet. */
export function queryD1IfTableExists(database: string, command: string): Array<Record<string, unknown>> | null {
  const result = wrangler(isolatedWranglerDirectory(), ".", [
    "d1", "execute", database, "--remote", "--json", "--command", command,
  ], undefined, { quiet: true, allowFailure: true });
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/no such table/i.test(output)) return null;
    throw new Error(`D1 query failed on ${database}: ${output.trim().slice(-2_000)}`);
  }
  return d1Rows(result.stdout);
}

function d1(database: string, args: string[]) {
  return wrangler(isolatedWranglerDirectory(), ".", [
    "d1", "execute", database, "--remote", ...args,
  ], undefined, { quiet: true });
}

function d1Rows(stdout: string): Array<Record<string, unknown>> {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value)) throw new Error("Wrangler returned invalid D1 query output");
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const rows = (entry as { results?: unknown }).results;
    return Array.isArray(rows)
      ? rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      : [];
  });
}

export function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
