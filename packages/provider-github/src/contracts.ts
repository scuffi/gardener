import {
  operationKindSchema,
  operationKindValues,
  operationReceiptSchema,
  operationSchema,
  repositoryEventV2Schema,
  repositoryRefSchema,
  type Operation,
  type OperationKind,
  type OperationReceipt,
  type RepositoryEventV2,
  type RepositoryRef,
} from "@gardener/contracts";
import { z } from "zod";

export const GITHUB_GATEWAY_CONTRACT_VERSION = "github-gateway/v1" as const;

export const availableGitHubOperationKinds = [
  "issue.label.add",
  "issue.label.remove",
  "issue.comment.create",
  "issue.comment.update",
  "issue.close",
  "issue.reopen",
  "pull_request.review.submit",
  "pull_request.update",
  "branch.create",
  "commit.create",
  "pull_request.open_draft",
  "pull_request.merge",
] as const satisfies readonly OperationKind[];

const availableOperations = new Set<OperationKind>(availableGitHubOperationKinds);
export const unavailableGitHubOperationKinds = operationKindValues.filter(
  (kind) => !availableOperations.has(kind),
);

const opaqueId = z.string().min(16).max(255).regex(/^[A-Za-z0-9:_-]+$/);
const githubNumericId = z.string().regex(/^[1-9][0-9]{0,31}$/);
const githubLogin = z.string().min(1).max(39).regex(
  /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
);

export const githubProviderIdentitySchema = z.object({
  provider: z.literal("github"),
  subject: githubNumericId,
  login: githubLogin,
}).strict();
export type GitHubProviderIdentity = z.infer<typeof githubProviderIdentitySchema>;

export const githubGatewayHealthSchema = z.object({
  contractVersion: z.literal(GITHUB_GATEWAY_CONTRACT_VERSION),
  ready: z.boolean(),
  database: z.boolean(),
  githubApp: z.boolean(),
  gardenerBinding: z.boolean(),
}).strict();
export type GitHubGatewayHealth = z.infer<typeof githubGatewayHealthSchema>;

export const beginGitHubLoginResultSchema = z.object({
  authorizationUrl: z.url(),
}).strict();
export type BeginGitHubLoginResult = z.infer<typeof beginGitHubLoginResultSchema>;

export const completeGitHubLoginSchema = z.object({
  handoffId: opaqueId,
  identity: githubProviderIdentitySchema,
  expiresAt: z.number().int().positive(),
}).strict();
export type CompleteGitHubLogin = z.infer<typeof completeGitHubLoginSchema>;

export const completeGitHubLoginResultSchema = z.object({
  accepted: z.literal(true),
}).strict();
export type CompleteGitHubLoginResult = z.infer<typeof completeGitHubLoginResultSchema>;

export const githubInstallationRequestSchema = z.object({
  requestId: opaqueId,
  requestedBy: githubProviderIdentitySchema,
}).strict();
export type GitHubInstallationRequest = z.infer<typeof githubInstallationRequestSchema>;

export const beginGitHubInstallationResultSchema = z.object({
  installationUrl: z.url(),
}).strict();
export type BeginGitHubInstallationResult = z.infer<typeof beginGitHubInstallationResultSchema>;

export const githubInstallationSchema = z.object({
  id: githubNumericId,
  accountId: githubNumericId,
  accountLogin: z.string().min(1).max(255),
  accountType: z.enum(["User", "Organization"]),
  active: z.boolean(),
}).strict();
export type GitHubInstallation = z.infer<typeof githubInstallationSchema>;

export const connectedGitHubRepositorySchema = repositoryRefSchema.extend({
  provider: z.literal("github"),
}).strict();
export type ConnectedGitHubRepository = z.infer<typeof connectedGitHubRepositorySchema>;

export const finalizeGitHubInstallationResultSchema = z.object({
  installation: githubInstallationSchema,
  repositories: z.array(connectedGitHubRepositorySchema),
}).strict();
export type FinalizeGitHubInstallationResult = z.infer<typeof finalizeGitHubInstallationResultSchema>;

export const githubRepositorySyncResultSchema = z.object({
  repositories: z.array(connectedGitHubRepositorySchema),
}).strict();
export type GitHubRepositorySyncResult = z.infer<typeof githubRepositorySyncResultSchema>;

export const resolveGitHubUsernameSchema = z.object({
  login: githubLogin,
}).strict();
export type ResolveGitHubUsername = z.infer<typeof resolveGitHubUsernameSchema>;

export const resolveGitHubUsernameResultSchema = z.object({
  identity: githubProviderIdentitySchema.nullable(),
}).strict();
export type ResolveGitHubUsernameResult = z.infer<typeof resolveGitHubUsernameResultSchema>;

export const githubOperationCapabilitySchema = z.object({
  kind: operationKindSchema,
  available: z.boolean(),
}).strict();
export const githubGatewayCapabilitiesSchema = z.object({
  contractVersion: z.literal(GITHUB_GATEWAY_CONTRACT_VERSION),
  operations: z.array(githubOperationCapabilitySchema).length(operationKindValues.length),
}).strict().superRefine((value, context) => {
  const kinds = value.operations.map((operation) => operation.kind);
  if (new Set(kinds).size !== operationKindValues.length) {
    context.addIssue({ code: "custom", message: "Each GitHub operation kind must appear exactly once" });
    return;
  }
  for (const kind of operationKindValues) {
    if (!kinds.includes(kind)) {
      context.addIssue({ code: "custom", message: `Missing GitHub operation capability: ${kind}` });
    }
  }
});
export type GitHubGatewayCapabilities = z.infer<typeof githubGatewayCapabilitiesSchema>;

export const executeGitHubOperationRequestSchema = z.object({
  runId: opaqueId,
  eventId: z.string().min(1).max(255),
  operation: operationSchema,
}).strict().superRefine((value, context) => {
  if (![
    "issue.comment.create",
    "pull_request.review.submit",
    "pull_request.open_draft",
  ].includes(value.operation.kind)) return;
  const operation = value.operation as Extract<Operation, {
    kind: "issue.comment.create" | "pull_request.review.submit" | "pull_request.open_draft";
  }>;
  const marker = `<!-- gardener-operation:${operation.id} -->`;
  if (operation.body !== marker && !operation.body.endsWith(`\n${marker}`)) {
    context.addIssue({
      code: "custom",
      path: ["operation", "body"],
      message: "Gateway rendered content requires the exact host operation marker",
    });
  }
});
export interface ExecuteGitHubOperationRequest {
  runId: string;
  eventId: string;
  operation: Operation;
}

export const executeGitHubOperationResultSchema = z.object({
  receipt: operationReceiptSchema,
}).strict();
export interface ExecuteGitHubOperationResult {
  receipt: OperationReceipt;
}

export const deliverGitHubEventSchema = z.object({
  event: repositoryEventV2Schema,
  eventHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export interface DeliverGitHubEvent {
  event: RepositoryEventV2;
  eventHash: string;
}

export const deliverGitHubEventResultSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  runIds: z.array(z.string().min(1).max(255)),
}).strict();
export type DeliverGitHubEventResult = z.infer<typeof deliverGitHubEventResultSchema>;

export const gatewayDeliverySummarySchema = z.object({
  deliveryId: z.string().min(1).max(255),
  eventName: z.string().min(1).max(100),
  repository: z.string().min(1).max(256).nullable(),
  status: z.enum(["received", "delivering", "delivered", "failed"]),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().max(500).nullable(),
  receivedAt: z.string(),
  deliveredAt: z.string().nullable(),
}).strict();
export type GatewayDeliverySummary = z.infer<typeof gatewayDeliverySummarySchema>;

export const gatewayDoctorResultSchema = z.object({
  health: githubGatewayHealthSchema,
  capabilities: githubGatewayCapabilitiesSchema,
  failedDeliveries: z.array(gatewayDeliverySummarySchema),
  staleDeliveries: z.array(gatewayDeliverySummarySchema),
}).strict();
export type GatewayDoctorResult = z.infer<typeof gatewayDoctorResultSchema>;

export const retryGatewayDeliverySchema = z.object({
  deliveryId: z.string().min(1).max(255),
}).strict();
export type RetryGatewayDelivery = z.infer<typeof retryGatewayDeliverySchema>;

export const retryGatewayDeliveryResultSchema = z.object({
  delivery: gatewayDeliverySummarySchema,
}).strict();
export type RetryGatewayDeliveryResult = z.infer<typeof retryGatewayDeliveryResultSchema>;

/** Private RPC capability bound into Gardener. No provider credential crosses this interface. */
export interface GitHubGatewayRpc {
  health(): Promise<GitHubGatewayHealth>;
  capabilities(): Promise<GitHubGatewayCapabilities>;
  beginLogin(): Promise<BeginGitHubLoginResult>;
  beginInstallation(input: GitHubInstallationRequest): Promise<BeginGitHubInstallationResult>;
  finalizeInstallation(input: GitHubInstallationRequest): Promise<FinalizeGitHubInstallationResult>;
  syncRepositories(): Promise<GitHubRepositorySyncResult>;
  resolveUsername(input: ResolveGitHubUsername): Promise<ResolveGitHubUsernameResult>;
  executeOperation(input: ExecuteGitHubOperationRequest): Promise<ExecuteGitHubOperationResult>;
}

/** Private RPC capability bound into the GitHub Gateway. */
export interface GardenerGitHubIngressRpc {
  health(): Promise<{
    contractVersion: typeof GITHUB_GATEWAY_CONTRACT_VERSION;
    ready: boolean;
    workspaceId: string;
  }>;
  completeLogin(input: CompleteGitHubLogin): Promise<CompleteGitHubLoginResult>;
  deliverGitHubEvent(input: DeliverGitHubEvent): Promise<DeliverGitHubEventResult>;
}

export type { Operation, OperationKind, OperationReceipt, RepositoryEventV2, RepositoryRef };
