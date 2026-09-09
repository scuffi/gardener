import type { Operation } from "@gardener/contracts";

/** JSON serialization with recursively sorted object keys and omitted undefined properties. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export async function canonicalSha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function stableHash(value: unknown): string {
  const input = canonicalJson(value);
  const pass = (seed: bigint): string => {
    let hash = seed;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= BigInt(input.charCodeAt(index));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
  };
  return pass(0xcbf29ce484222325n) + pass(0x84222325cbf29ce4n);
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
/** Stable across retries when proposal slot and canonical operation content match. */
export function createOperationId(runId: string, proposalIndex: number, operation?: WithoutId<Operation>): string {
  if (!runId.trim()) throw new Error("runId is required");
  if (!Number.isSafeInteger(proposalIndex) || proposalIndex < 0) throw new Error("proposalIndex must be a non-negative safe integer");
  const suffix = operation === undefined ? `${proposalIndex}` : `${proposalIndex}:${stableHash(operation)}`;
  return `${runId}:operation:${suffix}`;
}
