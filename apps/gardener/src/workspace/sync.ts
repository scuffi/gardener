import type { SyncRetryIntent, SyncRetryScheduler, WorkspaceRetryPendingSyncResult } from "@cloudflare/computer";
import type { ExecutionBackend, WorkspaceSyncStatus } from "./types";

const INTENT_PREFIX = "gardener:computer:sync:intent:";
const RESULT_PREFIX = "gardener:computer:sync:result:";

interface SyncStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number | Date): Promise<void>;
}

export class DurableSyncScheduler implements SyncRetryScheduler {
  constructor(private readonly storage: SyncStorage) {}

  get(backend: string): Promise<SyncRetryIntent | undefined> {
    return this.storage.get<SyncRetryIntent>(`${INTENT_PREFIX}${backend}`);
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    await this.storage.put(`${INTENT_PREFIX}${intent.backend}`, intent);
    await this.storage.setAlarm(intent.notBefore);
  }

  async clear(backend: string): Promise<void> {
    await this.storage.delete(`${INTENT_PREFIX}${backend}`);
  }

  async record(backend: string, result: WorkspaceRetryPendingSyncResult): Promise<void> {
    await this.storage.put(`${RESULT_PREFIX}${backend}`, result);
  }

  async status(backend: ExecutionBackend): Promise<WorkspaceSyncStatus> {
    const intent = await this.get(backend);
    if (intent) {
      return {
        status: "pending",
        backend,
        attempt: intent.attempt,
        notBefore: intent.notBefore,
      };
    }
    const result = await this.storage.get<WorkspaceRetryPendingSyncResult>(`${RESULT_PREFIX}${backend}`);
    if (!result || result.status === "idle") return { status: "idle", backend };
    if (result.status === "complete") {
      return { status: "complete", backend, applied: result.applied, skipped: result.skipped.length };
    }
    if (result.status === "pending") {
      return {
        status: "pending",
        backend,
        attempt: result.attempt,
        notBefore: result.notBefore,
        error: result.error,
      };
    }
    if (result.status === "exhausted") {
      return { status: "exhausted", backend, attempt: result.attempt, error: result.error };
    }
    return { status: "lost", backend, error: result.error };
  }
}
