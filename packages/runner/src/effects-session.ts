import type { RunnerEffectReceiptV1 } from "@gardener/protocol";

/** The calls apply makes on an authenticated effects session. */
export interface EffectsCalls {
  priorEffectReceipt(planRunId: string, artifactSha256: string): PromiseLike<RunnerEffectReceiptV1 | null>;
  recordEffect(receipt: RunnerEffectReceiptV1): PromiseLike<RunnerEffectReceiptV1>;
}

/** One connection to the runtime: its session's calls and the transport they share. */
export interface EffectsConnection {
  session: EffectsCalls;
  /**
   * Registers `callback` for when the transport breaks. Cap'n Web runs these
   * synchronously before it rejects the calls still pending, so a rejected
   * call can tell a dead connection from an error the runtime returned.
   */
  onBroken(callback: (error: unknown) => void): void;
  dispose(): void;
}

/** The runtime could not be reached again within the reconnect budget. */
export class EffectsSessionLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EffectsSessionLostError";
  }
}

export const EFFECTS_MAX_RECONNECTS = 4;
const CALL_TIMEOUT_MS = 30_000;

interface LiveConnection {
  connection: EffectsConnection;
  broken: { error: unknown } | undefined;
}

/**
 * The effects job's session with the runtime, reconnected when its transport
 * breaks.
 *
 * Apply pushes to GitHub between calls, so the socket can sit idle while a
 * large commit is built, and a dropped connection then fails the call that
 * records the step it just applied. Both calls are safe to repeat on a new
 * connection: `priorEffectReceipt` only reads, and `recordEffect` returns the
 * stored receipt when it is sent again unchanged and only ever moves a
 * receipt forward. So a call that fails because the connection broke, or
 * that gets no answer at all, is sent again on a new one. A call the runtime
 * answered with an error is never repeated: that answer stands.
 */
export class ReconnectingEffectsSession implements EffectsCalls {
  readonly #connect: () => Promise<EffectsConnection>;
  readonly #maxReconnects: number;
  readonly #callTimeoutMs: number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #onReconnect: ((attempt: number, error: unknown) => void) | undefined;
  #live: LiveConnection | undefined;
  #closed = false;

  constructor(options: {
    connect(): Promise<EffectsConnection>;
    maxReconnects?: number;
    callTimeoutMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
    onReconnect?: (attempt: number, error: unknown) => void;
  }) {
    this.#connect = options.connect;
    this.#maxReconnects = options.maxReconnects ?? EFFECTS_MAX_RECONNECTS;
    this.#callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#onReconnect = options.onReconnect;
  }

  priorEffectReceipt(planRunId: string, artifactSha256: string): Promise<RunnerEffectReceiptV1 | null> {
    return this.#call((session) => session.priorEffectReceipt(planRunId, artifactSha256));
  }

  recordEffect(receipt: RunnerEffectReceiptV1): Promise<RunnerEffectReceiptV1> {
    return this.#call((session) => session.recordEffect(receipt));
  }

  [Symbol.dispose](): void {
    this.#closed = true;
    this.#live?.connection.dispose();
    this.#live = undefined;
  }

  async #call<T>(invoke: (session: EffectsCalls) => PromiseLike<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxReconnects; attempt += 1) {
      if (attempt > 0) {
        this.#onReconnect?.(attempt, lastError);
        await this.#delay(Math.min(5_000, 500 * 2 ** (attempt - 1)));
      }
      if (this.#closed) throw new Error("The Gardener effects session is closed");
      let live: LiveConnection;
      try {
        live = await this.#open();
      } catch (error) {
        // Reaching the runtime at all failed, such as fetching the OIDC token.
        lastError = error;
        continue;
      }
      try {
        return await this.#withTimeout(live, invoke(live.connection.session));
      } catch (error) {
        if (live.broken === undefined) throw error;
        lastError = live.broken.error;
        this.#drop(live);
      }
    }
    throw new EffectsSessionLostError(
      `Lost the connection to the Gardener runtime and could not reconnect after ${this.#maxReconnects} attempts: ${errorMessage(lastError)}`,
      { cause: lastError },
    );
  }

  /** The current connection, or a new one when there is none or it broke while idle. */
  async #open(): Promise<LiveConnection> {
    if (this.#live !== undefined && this.#live.broken === undefined) return this.#live;
    if (this.#live !== undefined) this.#drop(this.#live);
    const connection = await this.#connect();
    const live: LiveConnection = { connection, broken: undefined };
    connection.onBroken((error) => { live.broken ??= { error }; });
    this.#live = live;
    return live;
  }

  /**
   * A call with no answer in time is treated as a broken connection: a peer
   * that vanished without closing leaves the socket open, and the call would
   * otherwise wait until the job's own timeout.
   */
  async #withTimeout<T>(live: LiveConnection, call: PromiseLike<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`The Gardener runtime did not answer within ${Math.round(this.#callTimeoutMs / 1_000)}s`);
        live.broken ??= { error };
        reject(error);
      }, this.#callTimeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #drop(live: LiveConnection): void {
    try {
      live.connection.dispose();
    } catch {
      // Already torn down with its transport.
    }
    if (this.#live === live) this.#live = undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
