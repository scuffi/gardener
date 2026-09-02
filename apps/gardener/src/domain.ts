export {
  connectEventSchema,
  issueOperationSchema as operationSchema,
  issueResourceSchema,
  policyModeSchema,
  repositorySchema,
} from "@gardener/contracts";
export type {
  AgentProposal,
  AgentResult,
  ConnectEvent,
  IssueOperation as Operation,
  PolicyMode,
  Repository,
} from "@gardener/contracts";
export { createOperationId } from "@gardener/core";

export interface RunQueueMessage {
  runId: string;
}
