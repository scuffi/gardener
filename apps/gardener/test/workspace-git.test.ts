import type { GitClient, GitClientFactory } from "@cloudflare/computer/git";
import { describe, expect, it, vi } from "vitest";
import {
  assertLocalOnlyGitCli,
  createLocalOnlyGitClientFactory,
  LocalOnlyGitError,
} from "../src/workspace/local-git";

describe("local-only Computer git", () => {
  it.each(["clone", "fetch", "pull", "push", "ls-remote", "remote"])(
    "rejects the %s CLI operation",
    (command) => {
      expect(() => assertLocalOnlyGitCli({ argv: [command, "origin"] })).toThrow(LocalOnlyGitError);
    },
  );

  it("rejects ambiguous global git option forms", () => {
    expect(() => assertLocalOnlyGitCli({ argv: ["-C", "/workspace/repo", "fetch", "origin"] })).toThrow(
      /local-only/,
    );
    expect(() => assertLocalOnlyGitCli({ argv: ["-c", "alias.safe=fetch", "safe"] })).toThrow(/local-only/);
  });

  it("allows an explicit local command catalog", () => {
    expect(() => assertLocalOnlyGitCli({ argv: ["status", "--short"] })).not.toThrow();
    expect(() => assertLocalOnlyGitCli({ argv: ["diff", "--stat"] })).not.toThrow();
  });

  it("blocks network-bearing typed operations and shell CLI through the same proxy", async () => {
    const cli = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const fetch = vi.fn();
    const base = { cli, fetch } as unknown as GitClient;
    const factory: GitClientFactory = () => base;
    const client = createLocalOnlyGitClientFactory(factory)({
      ws: { provider: () => ({}) as never },
    });

    await expect(client.clone({ url: "https://example.test/repo" })).rejects.toThrow(/local-only/);
    await expect(client.fetch({ remote: "origin" })).rejects.toThrow(/local-only/);
    await expect(client.pull({ remote: "origin" })).rejects.toThrow(/local-only/);
    await expect(client.push({ remote: "origin" })).rejects.toThrow(/local-only/);
    await expect(client.cli({ argv: ["push", "origin", "main"] })).rejects.toThrow(/local-only/);
    await expect(client.cli({ argv: ["status"] })).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(cli).toHaveBeenCalledTimes(1);
  });

  it("does not allow credential or remote URL configuration through the typed client", async () => {
    const configSet = vi.fn();
    const base = { configSet, cli: vi.fn() } as unknown as GitClient;
    const client = createLocalOnlyGitClientFactory(() => base)({
      ws: { provider: () => ({}) as never },
    });

    await expect(client.configSet({ path: "credential.helper", value: "store" })).rejects.toThrow(/local-only/);
    await expect(client.configSet({ path: "remote.origin.url", value: "https://example.test/repo" })).rejects.toThrow(
      /local-only/,
    );
    expect(configSet).not.toHaveBeenCalled();
  });
});
