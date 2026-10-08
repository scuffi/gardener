import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

let executions = 0;

/**
 * Runs SQL that changes the database. The SQL goes in a file, not an
 * argument: enrolment SQL carries whole task bundles, which is past Windows'
 * command-line limit, and endpoint security tools may kill processes started
 * with very long arguments. Remote `--file` runs through D1's import, which
 * reports no rows and reports a SQL error as a failed import rather than
 * naming the statement, so queries stay on `--command`. The file is removed
 * afterwards; only a CLI killed outright leaves it, in the private directory.
 */
/**
 * Callers must keep every statement idempotent (upserts, or updates that can
 * repeat) and put anything that disables or removes rows last: an import may
 * stop part-way, and running the command again must then finish the job.
 */
export function executeD1(database: string, command: string): void {
  const directory = isolatedWranglerDirectory();
  const file = join(directory, `execute-${process.pid}-${++executions}.sql`);
  writeFileSync(file, command, { mode: 0o600, flag: "wx" });
  try {
    // --yes answers the confirmation wrangler asks before a remote import.
    d1(database, ["--yes", "--file", file]);
  } catch (error) {
    // The file is gone by the time anyone reads the error, so quote the SQL.
    const excerpt = command.length > 2_000 ? `${command.slice(0, 2_000)}…` : command;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nSQL: ${excerpt}`, { cause: error });
  } finally {
    unlinkSync(file);
  }
}

/** Queries go in an argument, so they must stay short; see executeD1. */
const MAX_QUERY_LENGTH = 1_000;

function shortQuery(command: string): string {
  if (command.length > MAX_QUERY_LENGTH) {
    throw new Error(`D1 query is ${command.length} characters; queries are passed as an argument and must stay under ${MAX_QUERY_LENGTH}. Use executeD1 for long SQL.`);
  }
  return command;
}

export function queryD1(database: string, command: string): Array<Record<string, unknown>> {
  return d1Rows(d1(database, ["--json", "--command", shortQuery(command)]).stdout);
}

/** Like queryD1, but returns null when the queried table does not exist yet. */
export function queryD1IfTableExists(database: string, command: string): Array<Record<string, unknown>> | null {
  const result = wrangler(isolatedWranglerDirectory(), ".", [
    "d1", "execute", database, "--remote", "--json", "--command", shortQuery(command),
  ], undefined, { quiet: true, allowFailure: true });
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/no such table/i.test(output)) return null;
    throw new Error(`D1 query failed on ${database}: ${output.trim().slice(-2_000)}`);
  }
  return d1Rows(result.stdout);
}

/** Runs D1 commands against a Gardener database, resolved by name through the selected account. */
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
