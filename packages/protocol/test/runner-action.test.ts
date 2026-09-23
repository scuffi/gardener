import { describe, expect, it } from "vitest";
import {
  githubReadRequestV1Schema,
  runnerActionV1Schema,
  runnerCaptureResultV1Schema,
  runnerEventV1Schema,
} from "../src/schema";

const base = {
  schemaVersion: "gardener.runner.action/v1" as const,
  sequence: 1,
  operationId: "op_one",
  timeoutMs: 30_000,
};

const shell = {
  ...base,
  kind: "shell.exec" as const,
  command: "pnpm test",
  cwd: "/workspace",
  maxOutputBytes: 1_024,
};

const restRead = {
  ...base,
  kind: "github.read" as const,
  request: { transport: "rest" as const, method: "GET" as const, path: "/repos/acme/widgets" },
  maxOutputBytes: 1_024,
};

describe("runner action contract", () => {
  it("accepts legacy pinned issue events while current bridges add exact precondition facts", () => {
    const legacy = {
      schemaVersion: "gardener.runner.event/v1",
      kind: "github.issue.opened",
      repository: { defaultBranch: "main" },
      issue: {
        id: "999",
        number: 1,
        title: "Bug",
        body: "Broken",
        labels: ["bug"],
        author: { id: "45369682", login: "scuffi" },
      },
    };
    expect(runnerEventV1Schema.parse(legacy)).toEqual(legacy);
  });

  it("keeps the qualified shell action shape byte-compatible", () => {
    expect(runnerActionV1Schema.parse(shell)).toEqual(shell);
  });

  it("accepts REST and GraphQL read actions", () => {
    expect(runnerActionV1Schema.parse(restRead)).toEqual(restRead);
    const graphql = {
      ...base,
      kind: "github.read" as const,
      request: {
        transport: "graphql" as const,
        query: "query Issue { repository(owner: \"a\", name: \"b\") { id } }",
        variables: { number: 7 },
        operationName: "Issue",
      },
      maxOutputBytes: 1_024,
    };
    expect(runnerActionV1Schema.parse(graphql)).toEqual(graphql);
  });

  it("rejects unknown kinds, mixed transports, and write methods", () => {
    expect(() => runnerActionV1Schema.parse({ ...shell, kind: "github.write" })).toThrow();
    expect(() => runnerActionV1Schema.parse({ ...restRead, command: "rm -rf /" })).toThrow();
    expect(() => runnerActionV1Schema.parse({
      ...restRead,
      request: { transport: "rest", method: "POST", path: "/repos/acme/widgets" },
    })).toThrow();
    expect(() => githubReadRequestV1Schema.parse({
      transport: "rest",
      method: "GET",
      path: "/x",
      query: "query { viewer { id } }",
    })).toThrow();
  });

  it("bounds GraphQL variables by count and serialized size", () => {
    const withVariables = (variables: Record<string, unknown>) => ({
      ...base,
      kind: "github.read" as const,
      request: { transport: "graphql" as const, query: "query Q { viewer { id } }", variables },
      maxOutputBytes: 1_024,
    });

    expect(() => runnerActionV1Schema.parse(withVariables({ a: 1, b: "two" }))).not.toThrow();

    // Actions are canonicalized into Durable Object storage, so an unbounded
    // variables map would let a model grow durable state without limit.
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]));
    expect(() => runnerActionV1Schema.parse(withVariables(tooMany))).toThrow();
    expect(() => runnerActionV1Schema.parse(withVariables({ big: "x".repeat(33 * 1024) }))).toThrow();
  });

  it("models the trusted capture action with nothing a model could fill", () => {
    const capture = {
      ...base,
      kind: "repository.capture" as const,
      baseSha: "a".repeat(40),
      maxOutputBytes: 4 * 1_024 * 1_024,
    };
    expect(runnerActionV1Schema.parse(capture)).toEqual(capture);

    // No path list, no filters, no directory: the whole tree is captured and
    // judged against the runner's own baseline, so there is no field through
    // which a task could choose what a commit contains.
    for (const smuggled of [{ paths: ["src"] }, { directory: "/tmp/x" }, { files: [] }, { maxBytes: 10 }]) {
      expect(() => runnerActionV1Schema.parse({ ...capture, ...smuggled })).toThrow();
    }
    expect(() => runnerActionV1Schema.parse({ ...capture, baseSha: "not-a-sha" })).toThrow();
  });

  it("carries a capture across the boundary as metadata only", () => {
    const captured = {
      schemaVersion: "gardener.runner.capture-result/v1" as const,
      status: "captured" as const,
      ref: {
        schemaVersion: "gardener.task-capture-ref/v1" as const,
        captureId: `cap_${"1".repeat(64)}`,
        baseSha: "a".repeat(40),
        manifestSha256: "b".repeat(64),
        changesSha256: "c".repeat(64),
        fileCount: 2,
        sizeBytes: 31,
      },
      manifestJson: "{}",
    };
    expect(runnerCaptureResultV1Schema.parse(captured)).toEqual(captured);
    expect(runnerCaptureResultV1Schema.parse({
      schemaVersion: "gardener.runner.capture-result/v1",
      status: "unchanged",
    })).toEqual({ schemaVersion: "gardener.runner.capture-result/v1", status: "unchanged" });

    // The envelope is strict and entirely scalar, so neither file bytes nor a
    // runner-local artifact path has anywhere to travel.
    expect(() => runnerCaptureResultV1Schema.parse({ ...captured, directory: "/tmp/gardener-capture/x" })).toThrow();
    expect(() => runnerCaptureResultV1Schema.parse({ ...captured, content: { "a.txt": "bytes" } })).toThrow();
    expect(() => runnerCaptureResultV1Schema.parse({
      ...captured,
      ref: { ...captured.ref, path: "/tmp/x" },
    })).toThrow();

    // An "unchanged" capture cannot smuggle a reference, and a real one cannot
    // omit the manifest its digest is supposed to cover.
    expect(() => runnerCaptureResultV1Schema.parse({
      schemaVersion: "gardener.runner.capture-result/v1",
      status: "unchanged",
      ref: captured.ref,
    })).toThrow();
    const { manifestJson: _omitted, ...withoutManifest } = captured;
    expect(() => runnerCaptureResultV1Schema.parse(withoutManifest)).toThrow();
  });

  it("bounds read payloads below the shell output ceiling", () => {
    expect(() => runnerActionV1Schema.parse({ ...restRead, maxOutputBytes: 4 * 1_024 * 1_024 })).toThrow();
    expect(runnerActionV1Schema.parse({ ...shell, maxOutputBytes: 4 * 1_024 * 1_024 }).maxOutputBytes)
      .toBe(4 * 1_024 * 1_024);
  });
});
