import {
  agentEffectProposalV1Schema,
  interruptionResponseV1Schema,
  interruptionSchema,
  operationReceiptSchema,
  operationSchema,
  runGrantV2Schema,
  type AgentEffectProposalV1,
  type Interruption,
  type InterruptionResponseV1,
  type Operation,
  type OperationReceipt,
  type RunGrantV2,
} from "@gardener/contracts";
import { canonicalSha256, deepFreeze } from "./stable";

export async function canonicalOperationHash(operationInput: Operation | unknown): Promise<string> {
  return canonicalSha256(operationSchema.parse(operationInput));
}

export async function operationHashMatches(operationInput: Operation | unknown, expectedHash: string): Promise<boolean> {
  return /^[a-f0-9]{64}$/.test(expectedHash) && await canonicalOperationHash(operationInput) === expectedHash;
}

export async function assertOperationHash(operationInput: Operation | unknown, expectedHash: string): Promise<Operation> {
  const operation = operationSchema.parse(operationInput);
  if (!await operationHashMatches(operation, expectedHash)) throw new Error("operation hash does not match canonical exact effect");
  return operation;
}

export async function createEffectProposal(input: Omit<AgentEffectProposalV1, "schemaVersion" | "operationHash">): Promise<Readonly<AgentEffectProposalV1>> {
  const operationHash = await canonicalOperationHash(input.operation);
  return deepFreeze(agentEffectProposalV1Schema.parse({ schemaVersion: "v1", ...input, operationHash }));
}

export async function validateEffectProposalBinding(input: unknown): Promise<Readonly<AgentEffectProposalV1>> {
  const proposal = agentEffectProposalV1Schema.parse(input);
  await assertOperationHash(proposal.operation, proposal.operationHash);
  return deepFreeze(proposal);
}

export async function validateEffectApprovalBinding(input: unknown): Promise<Readonly<Interruption>> {
  const interruption = interruptionSchema.parse(input);
  if (interruption.kind !== "effect_approval") throw new Error("expected an effect-approval interruption");
  await assertOperationHash(interruption.operation, interruption.operationHash);
  return deepFreeze(interruption);
}

export async function validateEffectApprovalResponseBinding(input: unknown, operationInput: Operation | unknown): Promise<Readonly<InterruptionResponseV1>> {
  const response = interruptionResponseV1Schema.parse(input);
  if (response.payload.kind !== "effect_approval") throw new Error("expected an effect-approval response");
  await assertOperationHash(operationInput, response.payload.operationHash);
  return deepFreeze(response);
}

export async function validateOperationGrantBinding(input: unknown, operationInput: Operation | unknown): Promise<Readonly<RunGrantV2>> {
  const grant = runGrantV2Schema.parse(input);
  const operation = operationSchema.parse(operationInput);
  const operationHash = await canonicalOperationHash(operation);
  const matchingScope = grant.scopes.find((scope) => scope.kind === "operation.execute" && scope.operationId === operation.id && scope.operationKind === operation.kind && scope.operationHash === operationHash);
  if (!matchingScope) throw new Error("run grant is not bound to the canonical exact operation");
  if (grant.repository.id !== operation.repository.id) throw new Error("run grant repository does not match the operation");
  return deepFreeze(grant);
}

export async function validateOperationReceiptBinding(input: unknown, operationInput: Operation | unknown): Promise<Readonly<OperationReceipt>> {
  const receipt = operationReceiptSchema.parse(input);
  const operation = operationSchema.parse(operationInput);
  const operationHash = await canonicalOperationHash(operation);
  if (receipt.operationId !== operation.id || receipt.kind !== operation.kind || receipt.operationHash !== operationHash) throw new Error("operation receipt is not bound to the canonical exact operation");
  return deepFreeze(receipt);
}
