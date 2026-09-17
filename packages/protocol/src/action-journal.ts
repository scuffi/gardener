import {
  runnerActionResultV1Schema,
  runnerActionV1Schema,
  type RunnerActionResultV1,
  type RunnerActionV1,
} from "./schema";

export type ActionJournalState = "queued" | "running" | "ambiguous" | "completed";

export interface ActionJournalRecord {
  action: RunnerActionV1;
  canonicalAction: string;
  state: ActionJournalState;
  result?: RunnerActionResultV1;
  canonicalResult?: string;
}

/**
 * Pure state machine used by the protocol spike. Production storage will put
 * these records behind a Durable Object; no Cap'n Web stub belongs here.
 */
export class ActionJournal {
  readonly #records = new Map<string, ActionJournalRecord>();
  readonly #sequences = new Map<number, string>();

  register(input: RunnerActionV1): ActionJournalRecord {
    const action = runnerActionV1Schema.parse(input);
    const canonicalAction = canonicalValue(action);
    const existing = this.#records.get(action.operationId);
    if (existing) {
      if (existing.canonicalAction !== canonicalAction) throw new Error("Operation ID was reused for different action input");
      return cloneRecord(existing);
    }
    const sequenceOwner = this.#sequences.get(action.sequence);
    if (sequenceOwner) throw new Error(`Action sequence is already owned by ${sequenceOwner}`);
    const record: ActionJournalRecord = { action, canonicalAction, state: "queued" };
    this.#records.set(action.operationId, record);
    this.#sequences.set(action.sequence, action.operationId);
    return cloneRecord(record);
  }

  claim(operationId: string): ActionJournalRecord {
    const record = this.#required(operationId);
    if (record.state === "completed") return cloneRecord(record);
    if (record.state === "running") throw new Error("Action is already running");
    if (record.state === "ambiguous") throw new Error("Ambiguous action must be reconciled, not replayed");
    record.state = "running";
    return cloneRecord(record);
  }

  markAmbiguous(operationId: string): ActionJournalRecord {
    const record = this.#required(operationId);
    if (record.state === "completed" || record.state === "ambiguous") return cloneRecord(record);
    if (record.state !== "running") throw new Error("Only a running action can become ambiguous");
    record.state = "ambiguous";
    return cloneRecord(record);
  }

  complete(input: RunnerActionResultV1): ActionJournalRecord {
    const result = runnerActionResultV1Schema.parse(input);
    const record = this.#required(result.operationId);
    if (record.action.sequence !== result.sequence) throw new Error("Action result sequence does not match its operation");
    const outputBytes = new TextEncoder().encode(result.stdout).byteLength + new TextEncoder().encode(result.stderr).byteLength;
    if (outputBytes > record.action.maxOutputBytes) throw new Error("Action result exceeds its declared output byte limit");
    const canonicalResult = canonicalValue(result);
    if (record.state === "completed") {
      if (record.canonicalResult !== canonicalResult) throw new Error("Completed operation was reused for a different result");
      return cloneRecord(record);
    }
    if (record.state !== "running" && record.state !== "ambiguous") {
      throw new Error("An unclaimed action cannot be completed");
    }
    record.state = "completed";
    record.result = result;
    record.canonicalResult = canonicalResult;
    return cloneRecord(record);
  }

  get(operationId: string): ActionJournalRecord | undefined {
    const record = this.#records.get(operationId);
    return record ? cloneRecord(record) : undefined;
  }

  unresolvedAfter(sequence: number): ActionJournalRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.action.sequence > sequence && record.state !== "completed")
      .sort((left, right) => left.action.sequence - right.action.sequence)
      .map(cloneRecord);
  }

  nextSequence(): number {
    return this.#sequences.size === 0 ? 1 : Math.max(...this.#sequences.keys()) + 1;
  }

  #required(operationId: string): ActionJournalRecord {
    const record = this.#records.get(operationId);
    if (!record) throw new Error(`Unknown operation ID: ${operationId}`);
    return record;
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}

function cloneRecord(record: ActionJournalRecord): ActionJournalRecord {
  return structuredClone(record);
}
