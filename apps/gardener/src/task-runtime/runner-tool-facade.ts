import { taskToolResultV1Schema, type TaskToolV1 } from "@gardener/contracts";
import type { RunnerActionResultV1 } from "@gardener/protocol";
import type { HarnessToolFacade, HarnessToolInvocation, JsonValue } from "../harness";
import type { TaskRunnerSession } from "./session";

const TASK_TOOL_BY_HARNESS_NAME = {
  repository_read_file: "repository.read_file",
  repository_list_files: "repository.list_files",
  repository_exec: "repository.exec",
} as const satisfies Record<string, TaskToolV1>;

/** Trusted Flue-to-session adapter. The model never chooses a session id. */
export class RunnerSessionToolFacade implements HarnessToolFacade {
  constructor(private readonly sessions: DurableObjectNamespace<TaskRunnerSession>) {}

  async invoke(invocation: HarnessToolInvocation): Promise<JsonValue> {
    const tool = TASK_TOOL_BY_HARNESS_NAME[invocation.toolName as keyof typeof TASK_TOOL_BY_HARNESS_NAME];
    if (!tool) throw new Error("Unknown task runner tool");
    const session = this.sessions.get(this.sessions.idFromName(invocation.runId));
    const result = await session.invokeHarnessTool(invocation) as RunnerActionResultV1;
    const parsed = taskToolResultV1Schema.parse({
      schemaVersion: "gardener.task-tool-result/v1",
      operationId: result.operationId,
      tool,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
    });
    return JSON.parse(JSON.stringify(parsed)) as JsonValue;
  }
}
