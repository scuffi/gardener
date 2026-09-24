import { describe, expect, it, vi } from "vitest";
import { fetchDispatchTarget } from "../src/dispatch-target";

describe("manual run targets", () => {
  it("reads the issue or pull request from the run's own repository without following redirects", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ number: 7 }));
    await expect(fetchDispatchTarget({ target: { kind: "issue", number: 7 }, repository: "o/r", token: "t", fetch }))
      .resolves.toEqual({ issue: { number: 7 } });
    await expect(fetchDispatchTarget({ target: { kind: "pull_request", number: 8 }, repository: "o/r", token: "t", fetch }))
      .resolves.toEqual({ pull_request: { number: 7 } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/o/r/issues/7",
      "https://api.github.com/repos/o/r/pulls/8",
    ]);
    const init = fetch.mock.calls[0]![1]!;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ authorization: "Bearer t" });
  });

  it("fails closed on a missing target, an error, an oversized body, or a bad repository", async () => {
    const respond = (response: Response) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response);
    const issue = { kind: "issue" as const, number: 7 };
    await expect(fetchDispatchTarget({ target: issue, repository: "o/r", token: "t", fetch: respond(new Response("", { status: 404 })) }))
      .rejects.toThrow(/issue #7 was not found in o\/r/);
    await expect(fetchDispatchTarget({ target: issue, repository: "o/r", token: "t", fetch: respond(new Response("", { status: 403 })) }))
      .rejects.toThrow(/failed \(403\)/);
    await expect(fetchDispatchTarget({ target: issue, repository: "o/r", token: "t", fetch: respond(new Response("x".repeat(1024 * 1024 + 1))) }))
      .rejects.toThrow(/too large/);
    await expect(fetchDispatchTarget({ target: issue, repository: "o/r/../x", token: "t", fetch: respond(Response.json({})) }))
      .rejects.toThrow(/owner\/name/);
    await expect(fetchDispatchTarget({ target: issue, repository: "o/r", token: "", fetch: respond(Response.json({})) }))
      .rejects.toThrow(/token is required/);
    for (const repository of ["../..", "o/..", "./r"]) {
      await expect(fetchDispatchTarget({ target: issue, repository, token: "t", fetch: respond(Response.json({})) }))
        .rejects.toThrow(/owner\/name/);
    }
  });
});
