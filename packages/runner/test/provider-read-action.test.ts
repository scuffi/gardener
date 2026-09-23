import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningShellExecutor } from "../src/executor";
import { GitHubReadClient } from "../src/github-read";
import { runnerActionV1Schema, type RunnerGitHubReadActionV1 } from "@gardener/protocol";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const TOKEN = "ghs_planning_read_token";

function readAction(overrides: Partial<RunnerGitHubReadActionV1> = {}): RunnerGitHubReadActionV1 {
  return runnerActionV1Schema.parse({
    schemaVersion: "gardener.runner.action/v1",
    sequence: 1,
    operationId: "operation-read-one",
    kind: "github.read",
    request: { transport: "rest", method: "GET", path: "/repos/acme/widgets/issues/7" },
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1_024,
    ...overrides,
  }) as RunnerGitHubReadActionV1;
}

async function temporaryWorkspace(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gardener-read-")));
  directories.push(directory);
  return directory;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("planning provider reads", () => {
  it("executes a REST read and returns bounded JSON without the token", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal) => new GitHubReadClient({
        token: TOKEN,
        signal,
        fetch: async (url, init) => {
          seen.push({ url, method: init.method, headers: init.headers });
          return jsonResponse({ number: 7, state: "open", updated_at: "2026-09-22T10:00:00Z" });
        },
      }),
    });

    const result = await executor.execute(readAction());

    expect(result).toMatchObject({ status: "completed", exitCode: 0, outputTruncated: false });
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ transport: "rest", status: 200, ok: true });
    expect(payload.json).toMatchObject({ number: 7, state: "open" });
    expect(seen[0]?.url).toBe("https://api.github.com/repos/acme/widgets/issues/7");
    expect(seen[0]?.method).toBe("GET");
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
  });

  it("surfaces provider error statuses as completed reads the model can reason about", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal) => new GitHubReadClient({
        token: TOKEN,
        signal,
        fetch: async () => jsonResponse({ message: "Not Found" }, 404),
      }),
    });

    const result = await executor.execute(readAction());

    expect(result.status).toBe("completed");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ status: 404, ok: false });
  });

  it("fails closed without leaking the token when the client rejects a mutation", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal) => new GitHubReadClient({
        token: TOKEN,
        signal,
        fetch: async () => jsonResponse({ data: null }),
      }),
    });

    const result = await executor.execute(readAction({
      request: { transport: "graphql", query: "mutation Bad { addComment(input: {}) { clientMutationId } }" },
    }));

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("reports a configuration failure when no read client is available", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace());

    const result = await executor.execute(readAction());

    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toMatch(/not configured/);
  });

  it("caches a completed read and rejects operation reuse with different input", async () => {
    let calls = 0;
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal) => new GitHubReadClient({
        token: TOKEN,
        signal,
        fetch: async () => {
          calls += 1;
          return jsonResponse({ ok: true });
        },
      }),
    });

    const first = await executor.execute(readAction());
    const replayed = await executor.execute(readAction());

    expect(calls).toBe(1);
    expect(replayed).toEqual(first);
    await expect(executor.execute(readAction({
      request: { transport: "rest", method: "GET", path: "/repos/acme/widgets/issues/8" },
    }))).rejects.toThrow(/different shell input/);
  });

  it("cancels an in-flight read and records it as cancelled", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal) => new GitHubReadClient({
        token: TOKEN,
        signal,
        fetch: (_url, init) => new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      }),
    });

    const pending = executor.execute(readAction());
    await executor.cancel("operation-read-one");
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(result.exitCode).toBeNull();
  });

  it("drops the parsed body rather than emitting truncated JSON", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal) => new GitHubReadClient({
        token: TOKEN,
        signal,
        fetch: async () => jsonResponse({ blob: "x".repeat(20_000) }),
      }),
    });

    const result = await executor.execute(readAction({ maxOutputBytes: 4_096 }));

    expect(result.status).toBe("completed");
    expect(result.outputTruncated).toBe(true);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.json).toBeNull();
    expect(payload.truncated).toBe(true);
  });

  it("derives the client response budget from the action output budget", async () => {
    const seen: number[] = [];
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal, maxResponseBytes) => {
        seen.push(maxResponseBytes);
        return new GitHubReadClient({
          token: TOKEN,
          signal,
          limits: { maxResponseBytes },
          fetch: async () => jsonResponse({ ok: true }),
        });
      },
    });

    await executor.execute(readAction({ maxOutputBytes: 8_192 }));

    // Without this a 4 KiB budget would still pull a megabyte off the wire.
    expect(seen).toEqual([8_192]);
  });

  it("never exceeds the byte budget and always emits parseable JSON", async () => {
    const huge = { blob: "\u00e9".repeat(40_000), nested: { deep: "y".repeat(10_000) } };
    for (const maxOutputBytes of [64, 128, 256, 1_024, 4_096, 65_536]) {
      const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
        createReadClient: (signal, responseBytes) => new GitHubReadClient({
          token: TOKEN,
          signal,
          limits: { maxResponseBytes: responseBytes },
          fetch: async () => jsonResponse(huge),
        }),
      });

      const result = await executor.execute(readAction({ maxOutputBytes }));
      const total = Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");

      expect(total, `budget ${maxOutputBytes}`).toBeLessThanOrEqual(maxOutputBytes);
      if (result.status === "completed") {
        expect(() => JSON.parse(result.stdout), `budget ${maxOutputBytes}`).not.toThrow();
        expect(result.outputTruncated).toBe(true);
      } else {
        // A budget too small for any envelope is an explicit failure, never a
        // silent empty success and never a stall.
        expect(result.status).toBe("failed");
        expect(result.exitCode).toBe(1);
      }
      expect(result.stdout).not.toContain(TOKEN);
      expect(result.stderr).not.toContain(TOKEN);
    }
  });

  it("bounds stderr on every failure path so no result can exceed the budget", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal) => new GitHubReadClient({
        token: TOKEN,
        signal,
        fetch: async () => {
          throw new Error("E".repeat(50_000));
        },
      }),
    });

    const result = await executor.execute(readAction({ maxOutputBytes: 200 }));

    expect(result.status).toBe("failed");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(200);
    expect(result.outputTruncated).toBe(true);
  });

  it("truncates on a character boundary rather than splitting UTF-8", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace(), {
      createReadClient: (signal, responseBytes) => new GitHubReadClient({
        token: TOKEN,
        signal,
        limits: { maxResponseBytes: responseBytes },
        fetch: async () => jsonResponse({ text: "\u{1f331}".repeat(5_000) }),
      }),
    });

    const result = await executor.execute(readAction({ maxOutputBytes: 512 }));

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(512);
    if (result.status === "completed") {
      expect(result.stdout).not.toContain("\uFFFD");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });
});
