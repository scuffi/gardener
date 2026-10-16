import { describe, expect, it, vi } from "vitest";
import { describeError, retryAfterMs, withRetries } from "../src/sync-main";

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

  it("waits for a Retry-After up to 30 seconds, and stops at a longer one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    const limited = (retryAfter: string) => new Response("", { status: 429, headers: { "retry-after": retryAfter } });

    // Longer than the planned delay: waited for. Shorter: the planned delay stands.
    const throttled = vi.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(limited("12"))
      .mockResolvedValueOnce(limited("0"))
      .mockResolvedValueOnce(new Response("ok"));
    await expect(withRetries("Sync", throttled, [1_000, 2_000], wait)).resolves.toMatchObject({ attempt: 3 });
    expect(waits).toEqual([12_000, 2_000]);

    // Exactly 30 seconds is waited for; past it, the 429 is returned at once.
    waits.length = 0;
    const atLimit = vi.fn<() => Promise<Response>>().mockResolvedValueOnce(limited("30")).mockResolvedValueOnce(new Response("ok"));
    await expect(withRetries("Sync", atLimit, [1_000], wait)).resolves.toMatchObject({ attempt: 2 });
    expect(waits).toEqual([30_000]);
    waits.length = 0;
    const tooLong = vi.fn(async () => limited("31"));
    const { response, attempt } = await withRetries("Sync", tooLong, [1_000, 2_000], wait);
    expect([response.status, attempt]).toEqual([429, 1]);
    expect(tooLong).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(log).toHaveBeenLastCalledWith("Sync failed (attempt 1): HTTP 429, and it asks to retry after 31 s, longer than this job waits; not retrying");

    // A 5xx is treated the same way.
    const unavailable = vi.fn(async () => new Response("", { status: 503, headers: { "retry-after": "600" } }));
    await expect(withRetries("Sync", unavailable, [1_000], wait)).resolves.toMatchObject({ attempt: 1 });
    expect(unavailable).toHaveBeenCalledTimes(1);

    // The last attempt returns its response without reading the header.
    const last = new Response("", { status: 429 });
    const read = vi.spyOn(last.headers, "get");
    const exhausted = vi.fn<() => Promise<Response>>().mockResolvedValueOnce(limited("1")).mockResolvedValueOnce(last);
    await expect(withRetries("Sync", exhausted, [1_000], wait)).resolves.toMatchObject({ attempt: 2 });
    expect(read).not.toHaveBeenCalled();

    // A retried response's body is released.
    const discarded = limited("1");
    const cancel = vi.spyOn(discarded.body!, "cancel");
    await withRetries("Sync", vi.fn<() => Promise<Response>>().mockResolvedValueOnce(discarded).mockResolvedValueOnce(new Response("ok")), [1_000], wait);
    expect(cancel).toHaveBeenCalled();
    log.mockRestore();
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(retryAfterMs("5", now)).toBe(5_000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
    expect(retryAfterMs("Tue, 13 Oct 2026 12:00:20 GMT", now)).toBe(20_000);
    expect(retryAfterMs("Tue, 13 Oct 2026 11:59:00 GMT", now)).toBe(0);
    // The two obsolete forms recipients must also accept: RFC 850, and asctime, which is in GMT.
    expect(retryAfterMs("Tuesday, 13-Oct-26 12:00:20 GMT", now)).toBe(20_000);
    expect(retryAfterMs("Tue Oct 13 12:00:20 2026", now)).toBe(20_000);
    for (const unreadable of [null, "", "soon", "-5", "1.5"]) expect(retryAfterMs(unreadable, now)).toBeUndefined();
  });

  it("describes errors without a cause, and non-errors", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("text")).toBe("text");
  });
});
