import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { TASK_TOOL_BY_HARNESS_NAME } from "../src/task-runtime/tool-authority";
import { taskToolInputKeys, taskToolInputSchema, taskToolInputSchemas } from "../src/task-runtime/tool-input-schemas";

describe("repository tool input schemas", () => {
  it("define exactly one schema per harness tool", () => {
    expect(Object.keys(taskToolInputSchemas).sort()).toEqual(Object.keys(TASK_TOOL_BY_HARNESS_NAME).sort());
    expect(() => taskToolInputSchema("repository_delete")).toThrow(/no input schema/);
    expect(() => taskToolInputSchema("toString")).toThrow(/no input schema/);
  });

  it("advertise only the fields each tool accepts", () => {
    expect(taskToolInputKeys("repository_read_file")).toEqual(["path"]);
    expect(taskToolInputKeys("repository_list_files")).toEqual(["path", "maxEntries"]);
    expect(taskToolInputKeys("repository_exec")).toEqual(["command", "cwd", "timeoutMs", "maxOutputBytes"]);
    expect([...taskToolInputKeys("provider_api_read")].sort()).toEqual(
      ["maxOutputBytes", "method", "operationName", "path", "query", "timeoutMs", "transport", "variables"],
    );
  });

  it("accept the documented shapes", () => {
    expect(v.safeParse(taskToolInputSchema("provider_api_read"), { transport: "rest", path: "/repos/o/r/pulls/5/files" }).success).toBe(true);
    expect(v.safeParse(taskToolInputSchema("provider_api_read"), { path: "/repos/o/r/pulls/5", method: "HEAD" }).success).toBe(true);
    expect(v.safeParse(taskToolInputSchema("provider_api_read"), { transport: "graphql", query: "query { viewer { login } }", variables: { n: 1 } }).success).toBe(true);
    expect(v.safeParse(taskToolInputSchema("repository_read_file"), { path: "README.md" }).success).toBe(true);
    expect(v.safeParse(taskToolInputSchema("repository_list_files"), {}).success).toBe(true);
    expect(v.safeParse(taskToolInputSchema("repository_exec"), { command: "npm test", timeoutMs: 60_000 }).success).toBe(true);
  });

  it("refuse fields that belong to another tool", () => {
    // The shape models produced when every tool shared one schema.
    expect(v.safeParse(taskToolInputSchema("provider_api_read"), { command: "gh pr view 5" }).success).toBe(false);
    expect(v.safeParse(taskToolInputSchema("repository_read_file"), { path: "a", maxEntries: 3 }).success).toBe(false);
    expect(v.safeParse(taskToolInputSchema("repository_exec"), { command: "ls", path: "a" }).success).toBe(false);
    expect(v.safeParse(taskToolInputSchema("provider_api_read"), { path: "/x", method: "POST" }).success).toBe(false);
    expect(v.safeParse(taskToolInputSchema("repository_list_files"), { maxEntries: 10_000 }).success).toBe(true);
    expect(v.safeParse(taskToolInputSchema("repository_list_files"), { maxEntries: 10_001 }).success).toBe(false);
  });

  it("leave cross-field provider rules to the session", () => {
    // The flat schema accepts an empty read; the session refuses it ("Invalid provider read path").
    expect(v.safeParse(taskToolInputSchema("provider_api_read"), {}).success).toBe(true);
  });
});
