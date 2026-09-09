import { z } from "zod";
import { runtimeCapabilityRequestSchema } from "./capabilities";
import { gardenerPrincipalSchema } from "./identity";
import { operationSchema } from "./operations";

const id = z.string().regex(/^[A-Za-z0-9:._-]{1,255}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const interruptionBase = z.object({
  schemaVersion: z.literal("v1"), id, runId: id, taskId: id, stepId: id, state: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]),
  eligibleResponders: z.array(gardenerPrincipalSchema).min(1).max(100), nonceHash: hash, createdAt: timestamp, expiresAt: timestamp, resolvedAt: timestamp.nullable(),
});

export const interruptionSchema = z.discriminatedUnion("kind", [
  interruptionBase.extend({ kind: z.literal("clarification"), question: z.string().trim().min(1).max(5_000), choices: z.array(z.object({ id, label: z.string().min(1).max(200) }).strict()).max(20), response: z.object({ text: z.string().max(10_000), choiceId: id.nullable() }).strict().nullable() }).strict(),
  interruptionBase.extend({ kind: z.literal("capability_request"), request: runtimeCapabilityRequestSchema, decision: z.enum(["allow_once", "reject", "revision_required", "never_allowed"]).nullable() }).strict(),
  interruptionBase.extend({ kind: z.literal("effect_approval"), operation: operationSchema, operationHash: hash, decision: z.enum(["approve_exact", "reject"]).nullable() }).strict(),
  interruptionBase.extend({ kind: z.literal("patch_review"), patchArtifactId: id, patchHash: hash, decision: z.enum(["approve", "reject", "request_changes"]).nullable(), response: z.string().max(10_000).nullable() }).strict(),
  interruptionBase.extend({ kind: z.literal("budget_request"), budget: z.enum(["turns", "tool_calls", "runtime", "tokens", "cost", "artifact_bytes"]), requestedAdditional: z.number().positive(), decision: z.enum(["allow_once", "reject"]).nullable() }).strict(),
]).superRefine((interruption, context) => {
  if (Date.parse(interruption.expiresAt) <= Date.parse(interruption.createdAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "interruption must expire after creation" });
  const resolution = interruption.kind === "clarification" ? interruption.response : interruption.decision;
  if (interruption.state === "pending") {
    if (resolution !== null) context.addIssue({ code: "custom", message: "pending interruption cannot have a resolution" });
    if (interruption.resolvedAt !== null) context.addIssue({ code: "custom", path: ["resolvedAt"], message: "pending interruption cannot have a resolution timestamp" });
    return;
  }
  if (interruption.resolvedAt === null) context.addIssue({ code: "custom", path: ["resolvedAt"], message: "resolved interruption requires a resolution timestamp" });
  if (interruption.resolvedAt !== null && Date.parse(interruption.resolvedAt) < Date.parse(interruption.createdAt)) context.addIssue({ code: "custom", path: ["resolvedAt"], message: "interruption cannot resolve before creation" });
  if ((interruption.state === "approved" || interruption.state === "rejected") && interruption.resolvedAt !== null && Date.parse(interruption.resolvedAt) > Date.parse(interruption.expiresAt)) context.addIssue({ code: "custom", path: ["resolvedAt"], message: "approval or rejection cannot occur after expiration" });
  if (interruption.state === "expired" && interruption.resolvedAt !== null && Date.parse(interruption.resolvedAt) < Date.parse(interruption.expiresAt)) context.addIssue({ code: "custom", path: ["resolvedAt"], message: "expiration cannot resolve before its deadline" });
  if (interruption.state === "expired" || interruption.state === "cancelled") {
    if (resolution !== null) context.addIssue({ code: "custom", message: "expired or cancelled interruption cannot contain a decision" });
    return;
  }
  if (interruption.kind !== "clarification" && resolution === null) context.addIssue({ code: "custom", path: ["decision"], message: "approved or rejected interruption requires a decision" });
  if (interruption.kind === "clarification") {
    if (interruption.state === "approved" && interruption.response === null) context.addIssue({ code: "custom", path: ["response"], message: "approved clarification requires a response" });
    if (interruption.state === "rejected" && interruption.response !== null) context.addIssue({ code: "custom", path: ["response"], message: "rejected clarification cannot contain a response" });
  } else if (interruption.kind === "capability_request") {
    const approved = interruption.decision === "allow_once";
    if ((interruption.state === "approved") !== approved) context.addIssue({ code: "custom", path: ["decision"], message: "capability decision is incompatible with interruption state" });
  } else if (interruption.kind === "effect_approval") {
    const approved = interruption.decision === "approve_exact";
    if ((interruption.state === "approved") !== approved) context.addIssue({ code: "custom", path: ["decision"], message: "effect decision is incompatible with interruption state" });
  } else if (interruption.kind === "patch_review") {
    const approved = interruption.decision === "approve";
    if ((interruption.state === "approved") !== approved) context.addIssue({ code: "custom", path: ["decision"], message: "patch decision is incompatible with interruption state" });
  } else {
    const approved = interruption.decision === "allow_once";
    if ((interruption.state === "approved") !== approved) context.addIssue({ code: "custom", path: ["decision"], message: "budget decision is incompatible with interruption state" });
  }
});
export type Interruption = z.infer<typeof interruptionSchema>;

export const interruptionResponseV1Schema = z.object({
  schemaVersion: z.literal("v1"), interruptionId: id, nonce: z.string().min(32).max(512), responder: gardenerPrincipalSchema,
  responseHash: hash, respondedAt: timestamp, payload: z.union([
    z.object({ kind: z.literal("clarification"), text: z.string().max(10_000), choiceId: id.nullable() }).strict(),
    z.object({ kind: z.literal("capability_request"), decision: z.enum(["allow_once", "reject", "revision_required", "never_allowed"]) }).strict(),
    z.object({ kind: z.literal("effect_approval"), decision: z.enum(["approve_exact", "reject"]), operationHash: hash }).strict(),
    z.object({ kind: z.literal("patch_review"), decision: z.enum(["approve", "reject", "request_changes"]), response: z.string().max(10_000).nullable() }).strict(),
    z.object({ kind: z.literal("budget_request"), decision: z.enum(["allow_once", "reject"]) }).strict(),
  ]),
}).strict();
export type InterruptionResponseV1 = z.infer<typeof interruptionResponseV1Schema>;

const inboxBase = z.object({
  schemaVersion: z.literal("v1"), id, instanceId: id, runId: id.nullable(), createdAt: timestamp, updatedAt: timestamp,
  status: z.enum(["unread", "open", "resolved", "dismissed"]), severity: z.enum(["info", "attention", "warning", "critical"]),
  title: z.string().trim().min(1).max(255), summary: z.string().trim().min(1).max(2_000),
});
export const inboxItemSchema = z.discriminatedUnion("kind", [
  inboxBase.extend({ kind: z.literal("interruption"), interruptionId: id }).strict(),
  inboxBase.extend({ kind: z.literal("run_failure"), errorCode: z.string().min(1).max(100), retryable: z.boolean() }).strict(),
  inboxBase.extend({ kind: z.literal("draft_activation"), draftId: id }).strict(),
  inboxBase.extend({ kind: z.literal("eval_regression"), revisionId: id, evalArtifactId: id }).strict(),
  inboxBase.extend({ kind: z.literal("temporary_grant_expiring"), grantId: id, expiresAt: timestamp }).strict(),
]);
export type InboxItem = z.infer<typeof inboxItemSchema>;
