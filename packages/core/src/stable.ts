import type { Operation } from "@gardener/contracts";

/** JSON serialization with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

// Two seeded FNV-1a passes provide a compact, deterministic identifier without a runtime crypto dependency.
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

/** Stable across retries: callers must retain proposal indexes for a run. */
export function createOperationId(runId: string, proposalIndex: number, operation?: Omit<Operation, "id">): string {
  if (!runId.trim()) throw new Error("runId is required");
  if (!Number.isSafeInteger(proposalIndex) || proposalIndex < 0) throw new Error("proposalIndex must be a non-negative safe integer");
  const suffix = operation === undefined ? `${proposalIndex}` : `${proposalIndex}:${stableHash(operation)}`;
  return `${runId}:operation:${suffix}`;
}
export const stableOperationId = createOperationId;
