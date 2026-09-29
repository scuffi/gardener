import { describe, expect, it, vi } from "vitest";
import { describeError, withRetries } from "../src/sync-main";

const connectionFailure = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }) });

describe("sync bridge retries", () => {
  it("retries connection failures and 5xx, and returns the first definitive answer", async () => {
    const request = vi.fn<() => Promise<Response>>()
      .mockRejectedValueOnce(connectionFailure())
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { response, attempt } = await withRetries("Sync", request, [0, 0, 0]);
    expect(response.status).toBe(200);
    expect(attempt).toBe(3);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "Sync failed (attempt 1): fetch failed (ECONNRESET: connect ECONNRESET); retrying",
      "Sync failed (attempt 2): HTTP 503; retrying",
    ]);
    log.mockRestore();
  });

  it("does not retry a refusal, and reports the cause once retries run out", async () => {
    const refused = vi.fn(async () => new Response("", { status: 403 }));
    await expect(withRetries("Sync", refused, [0, 0])).resolves.toMatchObject({ attempt: 1 });
    expect(refused).toHaveBeenCalledTimes(1);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const down = vi.fn(async () => { throw connectionFailure(); });
    await expect(withRetries("Sync", down, [0, 0])).rejects.toThrow("Sync failed: fetch failed (ECONNRESET: connect ECONNRESET)");
    expect(down).toHaveBeenCalledTimes(3);
    const busy = vi.fn(async () => new Response("", { status: 502 }));
    await expect(withRetries("Sync", busy, [0])).resolves.toMatchObject({ attempt: 2 });
    log.mockRestore();
  });

  it("describes errors without a cause, and non-errors", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("text")).toBe("text");
  });
});
