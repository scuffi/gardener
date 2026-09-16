/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { beginGitHubLogin, completeGitHubOAuthCallback } from "../src/oauth";
import { testDatabase } from "./d1";

const github = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock("../src/github-client", async (original) => {
  const module = await original<typeof import("../src/github-client")>();
  return { ...module, exchangeOAuthCode: github.exchange };
});

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

describe("Gateway OAuth handoff", () => {
  it("persists only the state hash and completes one immutable identity over RPC", async () => {
    const { sqlite, db } = testDatabase();
    try {
      github.exchange.mockResolvedValue({ id: "101", login: "owner" });
      const completeLogin = vi.fn().mockResolvedValue({ accepted: true });
      const env = {
        DB: db,
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
        GATEWAY_ORIGIN: "https://gateway.example.workers.dev",
        GARDENER_ORIGIN: "https://gardener.example.workers.dev",
        GARDENER: { completeLogin },
      } as unknown as Env;

      const started = await beginGitHubLogin(env);
      const authorization = new URL(started.authorizationUrl);
      const state = authorization.searchParams.get("state");
      expect(state).toMatch(/^login_/);
      const row = sqlite.prepare("SELECT state_hash FROM oauth_flows").get() as {
        state_hash: string;
      };
      expect(row.state_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.state_hash).not.toBe(state);
      expect((sqlite.prepare("PRAGMA table_info(oauth_flows)").all() as Array<{ name: string }>)
        .map((column) => column.name)).not.toContain("handoff_id");

      const destination = await completeGitHubOAuthCallback(env, {
        code: "temporary-code",
        state: state!,
      });
      expect(destination).toBe(
        `https://gardener.example.workers.dev/api/auth/github/complete?handoff=${state}`,
      );
      expect(completeLogin).toHaveBeenCalledWith(expect.objectContaining({
        handoffId: state,
        identity: { provider: "github", subject: "101", login: "owner" },
      }));
      expect(github.exchange).toHaveBeenCalledOnce();
      await expect(completeGitHubOAuthCallback(env, {
        code: "temporary-code",
        state: state!,
      })).rejects.toThrow("oauth_state_replayed");
    } finally { sqlite.close(); }
  });
});
