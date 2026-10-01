import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards the fix for "Subrequest depth limit exceeded".
 *
 * A Durable Object charges its outgoing calls to its newest incoming request,
 * so a session that read the agent while serving the agent's tool calls
 * deepened the request chain on every round trip until Cloudflare refused it.
 * The session must only wait for the agent's pushed completion. `session.ts`
 * cannot be imported under vitest, so this checks its source.
 */
const source = readFileSync(new URL("../src/task-runtime/session.ts", import.meta.url), "utf8");

describe("task session calls the agent one way", () => {
  it("never reads the agent continuously", () => {
    expect(source).not.toMatch(/harness\.read\(/);
    expect(source).not.toMatch(/\.read\(submission/);
    expect(source).toMatch(/this\.#awaitCompletion\(harness, submission/);
  });

  it("routes every agent-facing call through the in-flight tracker", () => {
    for (const method of [
      "invokeHarnessTool", "recordProposal", "listProposals", "admitCapture",
      "recordTaskCandidate", "confirmTaskResult", "recordTaskSettlement",
    ]) {
      const body = source.match(new RegExp(`\\n  async ${method}\\([^\\n]* \\{\\n([^\\n]*)\\n`));
      expect(body?.[1], method).toMatch(/return this\.#fromAgent\(/);
    }
  });

  it("looks at the agent only while no agent call is open", () => {
    const peekGuard = source.indexOf("this.#agentCallsInFlight === 0 && quietMs >= COMPLETION_PEEK_AFTER_MS");
    const peekCall = source.indexOf("harness.peek(");
    expect(peekGuard).toBeGreaterThan(0);
    expect(peekCall).toBeGreaterThan(peekGuard);
    expect(source.match(/harness\.peek\(/g)).toHaveLength(1);
  });
});
