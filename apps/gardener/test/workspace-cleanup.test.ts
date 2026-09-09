import { describe, expect, it } from "vitest";
import { CleanupLeaseManager, type CleanupLeaseStore } from "../src/workspace/cleanup";
import type { CleanupLease } from "../src/workspace/types";

function memoryStore(): CleanupLeaseStore & { value: CleanupLease | undefined } {
  return {
    value: undefined,
    async get() {
      return this.value;
    },
    async put(lease) {
      this.value = lease;
    },
    async delete() {
      this.value = undefined;
    },
  };
}

describe("workspace cleanup leases", () => {
  it("returns the active lease to the same owner and excludes another owner", async () => {
    const store = memoryStore();
    const manager = new CleanupLeaseManager(store, () => 1_000, () => "lease-1");
    const lease = await manager.acquire({ owner: "run-cleaner", ttlMs: 10_000 });
    await expect(manager.acquire({ owner: "run-cleaner", ttlMs: 10_000 })).resolves.toEqual(lease);
    await expect(manager.acquire({ owner: "other-cleaner", ttlMs: 10_000 })).rejects.toThrow(/already leased/);
  });

  it("consumes a matching lease exactly once", async () => {
    const store = memoryStore();
    const manager = new CleanupLeaseManager(store, () => 1_000, () => "lease-2");
    await manager.acquire({ owner: "run-cleaner", ttlMs: 10_000 });
    await expect(manager.consume("lease-2", "run-cleaner")).resolves.toMatchObject({ token: "lease-2" });
    await expect(manager.consume("lease-2", "run-cleaner")).rejects.toThrow(/missing, expired, or does not match/);
  });

  it("rejects expired, mismatched, and excessively long leases", async () => {
    const store = memoryStore();
    let now = 1_000;
    const manager = new CleanupLeaseManager(store, () => now, () => "lease-3");
    await manager.acquire({ owner: "run-cleaner", ttlMs: 1_000 });
    await expect(manager.consume("wrong", "run-cleaner")).rejects.toThrow(/does not match/);
    now = 2_001;
    await expect(manager.consume("lease-3", "run-cleaner")).rejects.toThrow(/expired/);
    await expect(manager.acquire({ owner: "run-cleaner", ttlMs: 300_001 })).rejects.toThrow(/5 minutes/);
  });
});
