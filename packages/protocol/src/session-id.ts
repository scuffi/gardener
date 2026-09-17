import type { RunnerHelloV1 } from "./schema";

export function runnerSessionId(hello: RunnerHelloV1): string {
  return `repo-${hello.repositoryId}-run-${hello.runId}-attempt-${hello.runAttempt}-${hello.phase}`;
}
