import type { PolicyMode } from "./domain";

export const setupProfileIds = ["safe", "review", "labels"] as const;
export type SetupProfileId = (typeof setupProfileIds)[number];

const profiles: Record<SetupProfileId, Record<string, PolicyMode>> = {
  safe: {
    "issue.label.add": "automatic",
    "issue.label.remove": "approval",
    "issue.comment.create": "approval",
    "issue.comment.update": "approval",
    "issue.close": "disabled",
    "issue.reopen": "disabled",
  },
  review: {
    "issue.label.add": "approval",
    "issue.label.remove": "approval",
    "issue.comment.create": "approval",
    "issue.comment.update": "approval",
    "issue.close": "disabled",
    "issue.reopen": "disabled",
  },
  labels: {
    "issue.label.add": "automatic",
    "issue.label.remove": "automatic",
    "issue.comment.create": "disabled",
    "issue.comment.update": "disabled",
    "issue.close": "disabled",
    "issue.reopen": "disabled",
  },
};

export function setupPolicyProfile(profile: SetupProfileId): Record<string, PolicyMode> {
  return { ...profiles[profile] };
}
