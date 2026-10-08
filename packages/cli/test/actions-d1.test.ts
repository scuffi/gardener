import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; sql: string | null; mode: number | null }> }));

vi.mock("../src/commands.js", async () => {
  const fs = await import("node:fs");
  return {
    wrangler: vi.fn((_cwd: string, _project: string, args: string[]) => {
      const file = args[args.indexOf("--file") + 1];
      const present = args.includes("--file") && fs.existsSync(file!);
      seen.calls.push({
        args,
        sql: present ? fs.readFileSync(file!, "utf8") : null,
        mode: present ? fs.statSync(file!).mode & 0o777 : null,
      });
      return { stdout: "[]", stderr: "", status: 0 };
    }),
  };
});

const { executeD1 } = await import("../src/actions-d1");

describe("executeD1", () => {
  it("passes the SQL in a private file, not an argument, and removes the file", () => {
    const sql = `INSERT INTO t VALUES ('${"x".repeat(50_000)}');`;
    executeD1("gardener-prod", sql);
    const call = seen.calls.at(-1)!;
    expect(call.args.slice(0, 5)).toEqual(["d1", "execute", "gardener-prod", "--remote", "--yes"]);
    expect(call.args).not.toContain("--command");
    expect(call.args.every((arg) => arg.length < 1_000)).toBe(true);
    expect(call.sql).toBe(sql);
    expect(call.mode).toBe(0o600);
    expect(existsSync(call.args[call.args.indexOf("--file") + 1]!)).toBe(false);
  });

  it("rejects a query too long to pass as an argument", async () => {
    const { queryD1 } = await import("../src/actions-d1");
    expect(() => queryD1("gardener-prod", `SELECT '${"x".repeat(1_000)}'`)).toThrow(/Use executeD1 for long SQL/);
  });

  it("removes the file when wrangler fails", async () => {
    const { wrangler } = await import("../src/commands.js");
    vi.mocked(wrangler).mockImplementationOnce((_cwd, _project, args) => {
      seen.calls.push({ args, sql: readFileSync(args[args.indexOf("--file") + 1]!, "utf8"), mode: statSync(args[args.indexOf("--file") + 1]!).mode & 0o777 });
      throw new Error("wrangler failed");
    });
    expect(() => executeD1("gardener-prod", "UPDATE t SET x=1;")).toThrow(/wrangler failed\nSQL: UPDATE t SET x=1;/);
    const call = seen.calls.at(-1)!;
    expect(existsSync(call.args[call.args.indexOf("--file") + 1]!)).toBe(false);
  });
});
