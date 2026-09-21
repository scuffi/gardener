import { z } from "zod";
import { githubNumericIdSchema } from "./identity";

const id = z.string().regex(/^[A-Za-z0-9:._-]{1,255}$/);
const timestamp = z.iso.datetime();

export const workspaceRoleValues = ["owner", "member"] as const;
export const workspaceRoleSchema = z.enum(workspaceRoleValues);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const workspacePermissionValues = [
  "workspace.view",
  "agent.draft.save",
  "agent.validate",
  "agent.simulate",
  "agent.revision.publish_paused",
  "agent.revision.activate",
  "inbox.dismiss",
  "run.cancel",
  "run.approve",
  "assignment.add",
  "assignment.expand",
  "assignment.enable",
  "assignment.pause",
  "assignment.resume",
  "assignment.disable",
  "assignment.remove",
  "policy.narrow",
  "policy.widen",
  "member.manage",
  "repository.sync",
  "installation.manage",
] as const;
export const workspacePermissionSchema = z.enum(workspacePermissionValues);
export type WorkspacePermission = z.infer<typeof workspacePermissionSchema>;

const memberPermissions = [
  "workspace.view",
  "agent.draft.save",
  "agent.validate",
  "agent.simulate",
  "agent.revision.publish_paused",
  "inbox.dismiss",
  "run.cancel",
  "assignment.pause",
  "assignment.disable",
  "assignment.remove",
  "policy.narrow",
] as const satisfies readonly WorkspacePermission[];

export const workspaceRolePermissions = Object.freeze({
  member: Object.freeze(memberPermissions),
  owner: Object.freeze(workspacePermissionValues),
}) satisfies Readonly<Record<WorkspaceRole, readonly WorkspacePermission[]>>;

export function workspaceRoleHasPermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return (workspaceRolePermissions[role] as readonly WorkspacePermission[]).includes(permission);
}

export const principalKindSchema = z.enum(["dashboard-session", "cloudflare-access", "mcp-token", "local-dev"]);
export type PrincipalKind = z.infer<typeof principalKindSchema>;

/** Provider-neutral user record. Provider identities are linked separately. */
export const internalUserV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, displayName: z.string().trim().min(1).max(255), createdAt: timestamp, disabledAt: timestamp.nullable(),
}).strict();
export type InternalUserV1 = z.infer<typeof internalUserV1Schema>;

/** Immutable provider+subject binding. Login is a mutable display hint only. */
export const externalIdentityV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, userId: id, provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  providerSubject: z.string().trim().min(1).max(255), login: z.string().trim().min(1).max(255), createdAt: timestamp,
}).strict();
export type ExternalIdentityV1 = z.infer<typeof externalIdentityV1Schema>;

export const workspaceMembershipV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, userId: id, role: workspaceRoleSchema, createdAt: timestamp, revokedAt: timestamp.nullable(),
}).strict();
export type WorkspaceMembershipV1 = z.infer<typeof workspaceMembershipV1Schema>;

export const workspaceInvitationV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, provider: z.literal("github"), providerSubject: githubNumericIdSchema,
  login: z.string().trim().min(1).max(255), role: workspaceRoleSchema, invitedByUserId: id,
  createdAt: timestamp, expiresAt: timestamp, acceptedAt: timestamp.nullable(), revokedAt: timestamp.nullable(),
}).strict().superRefine((invitation, context) => {
  if (Date.parse(invitation.expiresAt) <= Date.parse(invitation.createdAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "invitation expiry must follow creation" });
  if (invitation.acceptedAt !== null && invitation.revokedAt !== null) context.addIssue({ code: "custom", message: "invitation cannot be both accepted and revoked" });
});
export type WorkspaceInvitationV1 = z.infer<typeof workspaceInvitationV1Schema>;
