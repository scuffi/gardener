import { z } from "zod";
import { githubNumericIdSchema } from "./identity";

export const agentEligibilitySchema = z.object({
  actorIds: z.array(githubNumericIdSchema).max(100).default([]),
  resourceAuthorIds: z.array(githubNumericIdSchema).max(100).default([]),
  labelsAny: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  labelsAll: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  baseBranches: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
  includeDraftPullRequests: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  for (const key of ["actorIds", "resourceAuthorIds", "labelsAny", "labelsAll", "baseBranches"] as const) {
    if (new Set(value[key]).size !== value[key].length) context.addIssue({ code: "custom", path: [key], message: `${key} must be unique` });
  }
});
export type AgentEligibility = z.infer<typeof agentEligibilitySchema>;

export const eventEligibilityDecisionSchema = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string().min(1).max(500)).max(100),
  matchedTrigger: z.string().min(1).max(255).nullable(),
}).strict();
export type EventEligibilityDecision = z.infer<typeof eventEligibilityDecisionSchema>;
