import { operationKindSchema, type OperationKind } from "@gardener/contracts";
import type { PolicyMode } from "./domain";

export const setupProfileIds = ["safe", "review", "labels"] as const;
export type SetupProfileId = (typeof setupProfileIds)[number];

const allOperationsDisabled = Object.fromEntries(operationKindSchema.options.map((operation) => [operation, "disabled"])) as Record<OperationKind, PolicyMode>;

const profiles: Record<SetupProfileId, Record<OperationKind, PolicyMode>> = {
  safe: {
    ...allOperationsDisabled,
    "issue.label.add": "automatic",
    "issue.label.remove": "approval",
    "issue.comment.create": "approval",
    "issue.comment.update": "approval",
    "issue.close": "disabled",
    "issue.reopen": "disabled",
  },
  review: {
    ...allOperationsDisabled,
    "issue.label.add": "approval",
    "issue.label.remove": "approval",
    "issue.comment.create": "approval",
    "issue.comment.update": "approval",
    "issue.close": "disabled",
    "issue.reopen": "disabled",
  },
  labels: {
    ...allOperationsDisabled,
    "issue.label.add": "automatic",
    "issue.label.remove": "automatic",
    "issue.comment.create": "disabled",
    "issue.comment.update": "disabled",
    "issue.close": "disabled",
    "issue.reopen": "disabled",
  },
};

export function setupPolicyProfile(profile: SetupProfileId): Record<OperationKind, PolicyMode> {
  return { ...profiles[profile] };
}
