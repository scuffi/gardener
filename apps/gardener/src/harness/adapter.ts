import type {
  HarnessRequest,
  HarnessSubmission,
  HarnessToolFacade,
  HarnessToolInvocation,
  JsonValue,
} from "./types";
import { HarnessContractError, assertJsonValue } from "./validation";

/** Durable immutable request storage used by the Flue-native driver. */
export interface HarnessRequestStore {
  put(request: HarnessRequest): Promise<void>;
  get(runId: string, requestId: string): Promise<HarnessRequest | null>;
}

/** Durable request plus the one accepted Flue submission receipt. */
export interface HarnessSubmissionStore extends HarnessRequestStore {
  putSubmission(submission: HarnessSubmission): Promise<void>;
  getSubmission(runId: string, requestId: string): Promise<HarnessSubmission | null>;
}

/**
 * Observation/workspace tools are separately narrowed. Persistent provider
 * effects are available only through Gardener's trusted terminal tool.
 */
export class NarrowedHarnessToolFacade implements HarnessToolFacade {
  private calls = 0;
  private inputBytes = 0;
  private outputBytes = 0;

  get callCount(): number { return this.calls; }
  get modelOutputBytes(): number { return this.inputBytes; }
  get modelInputBytes(): number { return this.outputBytes; }

  constructor(
    private readonly request: HarnessRequest,
    private readonly delegate: HarnessToolFacade,
  ) {}

  async invoke(invocation: HarnessToolInvocation): Promise<JsonValue> {
    if (invocation.runId !== this.request.runId || invocation.requestId !== this.request.requestId) {
      throw new HarnessContractError("tool-denied", "Tool invocation is not bound to this harness request");
    }
    const tool = this.request.tools.find((candidate) => candidate.name === invocation.toolName);
    if (!tool) throw new HarnessContractError("tool-denied", `Harness requested unavailable tool ${invocation.toolName}`);
    if (tool.authority !== "observe" && tool.authority !== "workspace") {
      throw new HarnessContractError("tool-denied", "Harness tools cannot expand persistent authority");
    }
    if (this.calls >= this.request.budget.maxToolCalls) {
      throw new HarnessContractError("budget-exceeded", "Harness tool-call budget is exhausted");
    }
    assertJsonValue(invocation.input, "tool input");
    this.inputBytes += new TextEncoder().encode(JSON.stringify(invocation.input)).byteLength;
    this.calls += 1;
    const output = await this.delegate.invoke(invocation);
    assertJsonValue(output, "tool output");
    this.outputBytes += new TextEncoder().encode(JSON.stringify(output)).byteLength;
    return output;
  }
}
