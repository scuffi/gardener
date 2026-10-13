import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/harness";
import {
  MAX_GRAPHQL_VARIABLES,
  MAX_GRAPHQL_VARIABLES_BYTES,
  exactKeys,
  integer,
  providerReadAction,
  shellQuote,
  toolAction,
} from "../src/task-runtime/session-checks";

/**
 * `toolAction` and `providerReadAction` are the only gate between the model's
 * chosen JSON and the runner's shell and GitHub reads. Each refusal is matched
 * by its own message: the protocol schema re-checks several of these, so a
 * test that only expected "throws" would still pass with the session's guard gone.
 */
const OPERATION = `op_${"a".repeat(64)}`;

function invoke(toolName: string, input: JsonValue) {
  return toolAction(7, OPERATION, { runId: "run-1", requestId: "request-1", toolCallId: "call-1", toolName, input });
}

function read(input: Record<string, JsonValue>) {
  return providerReadAction(7, OPERATION, input);
}

/** Runs `printf '%s' <argument>` through a real POSIX shell and returns what it printed. */
function shellEcho(argument: string): string {
  return execFileSync("/bin/sh", ["-c", `printf '%s' ${argument}`], { encoding: "utf8" });
}

describe("provider read tool", () => {
  it("defaults to a bounded REST GET", () => {
    expect(read({ path: "/repos/o/r/pulls/5" })).toMatchObject({
      kind: "github.read",
      sequence: 7,
      operationId: OPERATION,
      request: { transport: "rest", method: "GET", path: "/repos/o/r/pulls/5" },
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1_024,
    });
    expect(read({ path: "/repos/o/r", method: "HEAD" })).toMatchObject({ request: { method: "HEAD" } });
  });

  it("permits only GET and HEAD", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "get", 1]) {
      expect(() => read({ path: "/repos/o/r/issues", method })).toThrow("The provider read tool permits only GET and HEAD");
    }
  });

  it("does not let a REST read carry GraphQL fields, or a GraphQL read carry REST fields", () => {
    expect(() => read({ path: "/repos/o/r", query: "query { viewer { login } }" })).toThrow("REST provider reads cannot carry GraphQL fields");
    expect(() => read({ path: "/repos/o/r", variables: {} })).toThrow("REST provider reads cannot carry GraphQL fields");
    expect(() => read({ path: "/repos/o/r", operationName: "Q" })).toThrow("REST provider reads cannot carry GraphQL fields");
    expect(() => read({ transport: "graphql", query: "query { a }", method: "GET" })).toThrow("GraphQL provider reads cannot carry REST fields");
    expect(() => read({ transport: "graphql", query: "query { a }", path: "/x" })).toThrow("GraphQL provider reads cannot carry REST fields");
  });

  it("refuses an unknown transport and invalid REST path or GraphQL query", () => {
    expect(() => read({ transport: "soap", path: "/x" })).toThrow("Provider read transport must be rest or graphql");
    expect(() => read({})).toThrow("Invalid provider read path");
    expect(() => read({ path: "" })).toThrow("Invalid provider read path");
    expect(() => read({ path: "x".repeat(2_049) })).toThrow("Invalid provider read path");
    expect(read({ path: "x".repeat(2_048) })).toMatchObject({ request: { path: "x".repeat(2_048) } });
    expect(() => read({ transport: "graphql" })).toThrow("Invalid provider read query");
    expect(() => read({ transport: "graphql", query: "q".repeat(32 * 1_024 + 1) })).toThrow("Invalid provider read query");
  });

  it("bounds GraphQL variables by size and count", () => {
    expect(MAX_GRAPHQL_VARIABLES_BYTES).toBe(32 * 1_024);
    expect(MAX_GRAPHQL_VARIABLES).toBe(64);
    // `{"a":""}` is 8 bytes, so this serializes to exactly the limit.
    const sized = (bytes: number) => ({ a: "x".repeat(bytes - 8) });
    expect(new TextEncoder().encode(JSON.stringify(sized(MAX_GRAPHQL_VARIABLES_BYTES))).byteLength).toBe(MAX_GRAPHQL_VARIABLES_BYTES);
    expect(read({ transport: "graphql", query: "query { a }", variables: sized(MAX_GRAPHQL_VARIABLES_BYTES) }))
      .toMatchObject({ request: { transport: "graphql", variables: sized(MAX_GRAPHQL_VARIABLES_BYTES) } });
    expect(() => read({ transport: "graphql", query: "query { a }", variables: sized(MAX_GRAPHQL_VARIABLES_BYTES + 1) }))
      .toThrow("Provider read variables exceed the size limit");

    const counted = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`v${index}`, index]));
    expect(read({ transport: "graphql", query: "query { a }", variables: counted(64) })).toMatchObject({ kind: "github.read" });
    expect(() => read({ transport: "graphql", query: "query { a }", variables: counted(65) }))
      .toThrow("Provider read variables exceed the count limit");
  });

  it("requires variables to be an object and operationName to be a string", () => {
    for (const variables of [null, [], "x", 1]) {
      expect(() => read({ transport: "graphql", query: "query { a }", variables })).toThrow("Provider read variables must be an object");
    }
    expect(() => read({ transport: "graphql", query: "query { a }", operationName: 1 })).toThrow("Invalid provider read operationName");
    expect(read({ transport: "graphql", query: "query Q { a }", operationName: "Q" })).toMatchObject({ request: { operationName: "Q" } });
  });

  it("bounds timeoutMs and maxOutputBytes", () => {
    expect(read({ path: "/x", timeoutMs: 1, maxOutputBytes: 1 })).toMatchObject({ timeoutMs: 1, maxOutputBytes: 1 });
    expect(read({ path: "/x", timeoutMs: 600_000, maxOutputBytes: 1_048_576 })).toMatchObject({ timeoutMs: 600_000, maxOutputBytes: 1_048_576 });
    for (const timeoutMs of [0, 600_001, 1.5, "1000"]) expect(() => read({ path: "/x", timeoutMs })).toThrow("Invalid timeoutMs");
    for (const maxOutputBytes of [0, 1_048_577, 2.5]) expect(() => read({ path: "/x", maxOutputBytes })).toThrow("Invalid maxOutputBytes");
  });

  it("refuses an unknown key", () => {
    expect(() => read({ path: "/x", headers: { authorization: "token" } })).toThrow("Unknown repository tool input headers");
  });
});

describe("repository tool actions", () => {
  it("requires an object input and a known tool", () => {
    for (const input of [null, [], "README.md", 1]) {
      expect(() => invoke("repository_read_file", input)).toThrow("Repository tool input must be an object");
    }
    expect(() => invoke("repository_delete", {})).toThrow("Unknown repository tool");
  });

  it("routes provider_api_read to the provider read action", () => {
    expect(invoke("provider_api_read", { path: "/x" })).toMatchObject({ kind: "github.read" });
    expect(() => invoke("provider_api_read", { path: "/x", method: "POST" })).toThrow("permits only GET and HEAD");
  });

  it("accepts no field for repository_merge_base", () => {
    expect(invoke("repository_merge_base", {})).toEqual({
      schemaVersion: "gardener.runner.action/v1",
      sequence: 7,
      operationId: OPERATION,
      kind: "repository.merge_base",
      timeoutMs: 300_000,
    });
    expect(() => invoke("repository_merge_base", { baseSha: "a".repeat(40) })).toThrow("Unknown repository tool input baseSha");
  });

  it("requires exactly the path for repository_read_file", () => {
    expect(() => invoke("repository_read_file", {})).toThrow("Missing repository tool input path");
    expect(() => invoke("repository_read_file", { path: "a", encoding: "base64" })).toThrow("Unknown repository tool input encoding");
    expect(() => invoke("repository_read_file", { path: "../etc/passwd" })).toThrow("Repository path escapes the workspace");
    expect(() => invoke("repository_read_file", { path: "/etc/passwd" })).toThrow("Invalid repository path");
    expect(invoke("repository_read_file", { path: "README.md" })).toMatchObject({
      kind: "shell.exec", cwd: "/workspace", timeoutMs: 30_000, maxOutputBytes: 256 * 1_024,
    });
  });

  it("bounds maxEntries for repository_list_files", () => {
    expect(invoke("repository_list_files", {})).toMatchObject({
      command: "git ls-files --cached --others --exclude-standard -- '.' | sed -n '1,1000p'",
    });
    expect(invoke("repository_list_files", { path: "src", maxEntries: 1 })).toMatchObject({ command: expect.stringContaining("-- 'src' | sed -n '1,1p'") });
    expect(invoke("repository_list_files", { maxEntries: 10_000 })).toMatchObject({ command: expect.stringContaining("'1,10000p'") });
    for (const maxEntries of [0, 10_001, 2.5, "10"]) {
      expect(() => invoke("repository_list_files", { maxEntries })).toThrow("Invalid maxEntries");
    }
    expect(() => invoke("repository_list_files", { path: "src", recursive: true })).toThrow("Unknown repository tool input recursive");
  });

  it("bounds command, cwd, timeoutMs and maxOutputBytes for repository_exec", () => {
    expect(invoke("repository_exec", { command: "npm test" })).toMatchObject({
      kind: "shell.exec", command: "npm test", cwd: "/workspace", timeoutMs: 30_000, maxOutputBytes: 256 * 1_024,
    });
    expect(invoke("repository_exec", { command: "ls", cwd: "packages/a", timeoutMs: 600_000, maxOutputBytes: 4 * 1_024 * 1_024 }))
      .toMatchObject({ cwd: "/workspace/packages/a", timeoutMs: 600_000, maxOutputBytes: 4 * 1_024 * 1_024 });

    expect(() => invoke("repository_exec", {})).toThrow("Invalid repository command");
    expect(() => invoke("repository_exec", { command: "" })).toThrow("Invalid repository command");
    expect(() => invoke("repository_exec", { command: "x".repeat(64 * 1_024 + 1) })).toThrow("Invalid repository command");
    expect(() => invoke("repository_exec", { command: ["ls"] })).toThrow("Invalid repository command");
    expect(invoke("repository_exec", { command: "x".repeat(64 * 1_024) })).toMatchObject({ kind: "shell.exec" });

    expect(() => invoke("repository_exec", { command: "ls", cwd: ".." })).toThrow("Repository path escapes the workspace");
    expect(() => invoke("repository_exec", { command: "ls", cwd: "a/../../b" })).toThrow("Repository path escapes the workspace");
    expect(() => invoke("repository_exec", { command: "ls", cwd: "/tmp" })).toThrow("Invalid repository path");

    for (const timeoutMs of [0, 600_001, 1.5]) expect(() => invoke("repository_exec", { command: "ls", timeoutMs })).toThrow("Invalid timeoutMs");
    for (const maxOutputBytes of [0, 4 * 1_024 * 1_024 + 1]) {
      expect(() => invoke("repository_exec", { command: "ls", maxOutputBytes })).toThrow("Invalid maxOutputBytes");
    }
    expect(() => invoke("repository_exec", { command: "ls", env: { A: "1" } })).toThrow("Unknown repository tool input env");
  });
});

describe("shell quoting of model-chosen paths", () => {
  const hostile = ["it's", "a'b'c", "'", "$(touch /tmp/gardener-pwned)", "`id`", "a;rm -rf x", "a b\tc", "$HOME", "x\\'y"];

  it("passes every path to the shell as one literal argument", () => {
    for (const value of hostile) expect(shellEcho(shellQuote(value))).toBe(value);
  });

  it("closes, escapes and reopens the quote around a single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(shellQuote("plain")).toBe("'plain'");
  });

  it("quotes the path inside the commands it builds", () => {
    const readCommand = (invoke("repository_read_file", { path: "docs/it's here.md" }) as { command: string }).command;
    expect(readCommand.endsWith(` 'docs/it'"'"'s here.md'`)).toBe(true);
    const listCommand = (invoke("repository_list_files", { path: "a'; touch pwned; '" }) as { command: string }).command;
    expect(listCommand).toBe(`git ls-files --cached --others --exclude-standard -- 'a'"'"'; touch pwned; '"'"'' | sed -n '1,1000p'`);
    expect(shellEcho(listCommand.slice("git ls-files --cached --others --exclude-standard -- ".length, -" | sed -n '1,1000p'".length)))
      .toBe("a'; touch pwned; '");
  });
});

describe("tool input helpers", () => {
  it("exactKeys refuses unknown keys and, unless optional, missing ones", () => {
    expect(() => exactKeys({ a: 1, b: 2 }, ["a"])).toThrow("Unknown repository tool input b");
    expect(() => exactKeys({}, ["a"])).toThrow("Missing repository tool input a");
    expect(() => exactKeys({}, ["a"], true)).not.toThrow();
    expect(() => exactKeys({ a: 1 }, ["a"])).not.toThrow();
  });

  it("integer accepts only safe integers within the inclusive bounds", () => {
    expect(integer(1, 1, 3, "n")).toBe(1);
    expect(integer(3, 1, 3, "n")).toBe(3);
    for (const value of [0, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", null]) {
      expect(() => integer(value as JsonValue, 1, 3, "n")).toThrow("Invalid n");
    }
    expect(() => integer(2 ** 53, 1, 2 ** 60, "n")).toThrow("Invalid n");
  });
});
