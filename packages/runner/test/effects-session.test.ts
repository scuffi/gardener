import { describe, expect, it, vi, type Mock } from "vitest";
import type { RunnerEffectReceiptV1 } from "@gardener/protocol";
import {
  EffectsSessionLostError,
  ReconnectingEffectsSession,
  type EffectsCalls,
  type EffectsConnection,
} from "../src/effects-session";

const RECEIPT = { planRunId: "run" } as RunnerEffectReceiptV1;

/** A connection whose calls `answer` decides; `drop` breaks it as Cap'n Web does. */
function fakeConnection(answer: (connection: FakeConnection) => EffectsCalls["recordEffect"]) {
  const broken: Array<(error: unknown) => void> = [];
  const connection: FakeConnection = {
    dispose: vi.fn(),
    onBroken: (callback) => { broken.push(callback); },
    drop: (error = new Error("WebSocket connection failed.")) => {
      for (const callback of broken) callback(error);
      return error;
    },
    session: undefined as unknown as EffectsCalls,
  };
  const recordEffect = answer(connection);
  connection.session = { recordEffect, priorEffectReceipt: async () => null };
  return connection;
}

interface FakeConnection extends EffectsConnection {
  dispose: Mock<() => void>;
  drop(error?: Error): Error;
}

/** A session over `connections`, opened in order, without real backoff. */
function sessionOver(connections: FakeConnection[], options: { maxReconnects?: number; callTimeoutMs?: number } = {}) {
  const connect = vi.fn(async () => {
    const next = connections.shift();
    if (!next) throw new Error("no connection left");
    return next;
  });
  const delays: number[] = [];
  const reconnects: Array<[number, string]> = [];
  const session = new ReconnectingEffectsSession({
    connect,
    delay: async (milliseconds) => { delays.push(milliseconds); },
    onReconnect: (attempt, error) => { reconnects.push([attempt, (error as Error).message]); },
    ...options,
  });
  return { session, connect, delays, reconnects };
}

describe("reconnecting effects session", () => {
  it("sends a call again on a new connection when the transport breaks under it", async () => {
    const dropped = fakeConnection((self) => async () => { throw self.drop(); });
    const healthy = fakeConnection(() => async (receipt) => receipt);
    const { session, connect, delays, reconnects } = sessionOver([dropped, healthy]);
    await expect(session.recordEffect(RECEIPT)).resolves.toBe(RECEIPT);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(dropped.dispose).toHaveBeenCalled();
    expect(reconnects).toEqual([[1, "WebSocket connection failed."]]);
    expect(delays).toEqual([500]);
  });

  it("opens a new connection for the next call when the transport broke while idle", async () => {
    const first = fakeConnection(() => async (receipt) => receipt);
    const second = fakeConnection(() => async (receipt) => receipt);
    const { session, connect, reconnects } = sessionOver([first, second]);
    await session.recordEffect(RECEIPT);
    first.drop();
    await session.recordEffect(RECEIPT);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalled();
    // Nothing failed, so there was nothing to report.
    expect(reconnects).toEqual([]);
  });

  it("keeps one connection across calls while it holds", async () => {
    const only = fakeConnection(() => async (receipt) => receipt);
    const { session, connect } = sessionOver([only]);
    await session.priorEffectReceipt("run", "c".repeat(64));
    await session.recordEffect(RECEIPT);
    await session.recordEffect(RECEIPT);
    expect(connect).toHaveBeenCalledTimes(1);
    session[Symbol.dispose]();
    expect(only.dispose).toHaveBeenCalledTimes(1);
  });

  it("never repeats a call the runtime answered with an error", async () => {
    const refusing = fakeConnection(() => async () => { throw new Error("Effect receipt persistence conflict"); });
    const { session, connect, reconnects } = sessionOver([refusing, fakeConnection(() => async (receipt) => receipt)]);
    await expect(session.recordEffect(RECEIPT)).rejects.toThrow("Effect receipt persistence conflict");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(reconnects).toEqual([]);
  });

  it("retries when reaching the runtime at all fails", async () => {
    const healthy = fakeConnection(() => async (receipt) => receipt);
    let calls = 0;
    const session = new ReconnectingEffectsSession({
      connect: async () => {
        calls += 1;
        if (calls === 1) throw new Error("OIDC token request failed");
        return healthy;
      },
      delay: async () => {},
    });
    await expect(session.recordEffect(RECEIPT)).resolves.toBe(RECEIPT);
    expect(calls).toBe(2);
  });

  it("treats a call with no answer as a broken connection", async () => {
    const silent = fakeConnection(() => () => new Promise<RunnerEffectReceiptV1>(() => {}));
    const healthy = fakeConnection(() => async (receipt) => receipt);
    const { session, reconnects } = sessionOver([silent, healthy], { callTimeoutMs: 10 });
    await expect(session.recordEffect(RECEIPT)).resolves.toBe(RECEIPT);
    expect(silent.dispose).toHaveBeenCalled();
    expect(reconnects).toEqual([[1, "The Gardener runtime did not answer within 0s"]]);
  });

  it("gives up after its reconnects, backing off between them, with the last transport error", async () => {
    const connections = Array.from({ length: 4 }, () => fakeConnection((self) => async () => { throw self.drop(); }));
    const { session, connect, delays } = sessionOver(connections, { maxReconnects: 3 });
    const failure = session.recordEffect(RECEIPT);
    await expect(failure).rejects.toThrow(EffectsSessionLostError);
    await expect(failure).rejects.toThrow(
      "Lost the connection to the Gardener runtime and could not reconnect after 3 attempts: WebSocket connection failed.",
    );
    expect(connect).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1_000, 2_000]);
  });

  it("refuses calls once disposed", async () => {
    const { session } = sessionOver([fakeConnection(() => async (receipt) => receipt)]);
    session[Symbol.dispose]();
    await expect(session.recordEffect(RECEIPT)).rejects.toThrow("The Gardener effects session is closed");
  });
});
