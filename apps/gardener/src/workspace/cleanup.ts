import type { CleanupLease, CleanupLeaseRequest } from "./types";

export interface CleanupLeaseStore {
  get(): Promise<CleanupLease | undefined>;
  put(lease: CleanupLease): Promise<void>;
  delete(): Promise<void>;
}

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60_000;

export class CleanupLeaseManager {
  constructor(
    private readonly store: CleanupLeaseStore,
    private readonly now: () => number = Date.now,
    private readonly randomToken: () => string = () => crypto.randomUUID(),
  ) {}

  async acquire(request: CleanupLeaseRequest): Promise<CleanupLease> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(request.owner)) {
      throw new Error("Invalid cleanup lease owner");
    }
    if (
      !Number.isSafeInteger(request.ttlMs) ||
      request.ttlMs < MIN_LEASE_MS ||
      request.ttlMs > MAX_LEASE_MS
    ) {
      throw new Error("Cleanup lease must be between 1 second and 5 minutes");
    }

    const now = this.now();
    const existing = await this.store.get();
    if (existing && existing.expiresAt > now) {
      if (existing.owner !== request.owner) {
        throw new Error("Workspace cleanup is already leased");
      }
      return existing;
    }

    const lease: CleanupLease = {
      token: this.randomToken(),
      owner: request.owner,
      issuedAt: now,
      expiresAt: now + request.ttlMs,
    };
    await this.store.put(lease);
    return lease;
  }

  async consume(token: string, owner: string): Promise<CleanupLease> {
    const lease = await this.store.get();
    const now = this.now();
    if (!lease || lease.token !== token || lease.owner !== owner || lease.expiresAt <= now) {
      throw new Error("Cleanup lease is missing, expired, or does not match");
    }
    await this.store.delete();
    return lease;
  }
}

export const cleanupLeaseLimits = {
  minMs: MIN_LEASE_MS,
  maxMs: MAX_LEASE_MS,
} as const;
