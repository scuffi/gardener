import {
  observationCapabilityValues,
  workspaceCapabilityValues,
} from "@gardener/contracts";
import { operationMetadata } from "../../lib/types";
import type {
  ObservationCapability,
  OperationKind,
  PolicyMode,
  WorkspaceCapability,
} from "../../lib/types";

export const policyModes: readonly PolicyMode[] = ["disabled", "approval", "automatic"];

export const modeRank: Record<PolicyMode, number> = {
  disabled: 0,
  approval: 1,
  automatic: 2,
};

export const modeLabels: Record<PolicyMode, string> = {
  disabled: "Disabled",
  approval: "Require approval",
  automatic: "Automatic",
};

export const operationKinds = Object.keys(operationMetadata) as OperationKind[];
export const observationCapabilities = [...observationCapabilityValues] as ObservationCapability[];
export const workspaceCapabilities = [...workspaceCapabilityValues] as WorkspaceCapability[];

export const operationGroups = [
  { label: "Issues", prefix: "issue." },
  { label: "Pull requests", prefix: "pull_request." },
  { label: "Code", values: ["branch.create", "commit.create"] },
  { label: "Discussions", prefix: "discussion." },
  { label: "Checks and releases", values: ["check.rerun"], prefix: "release." },
] as const;

export const observationLabels: Record<ObservationCapability, string> = {
  "github.repository.metadata.read": "Repository metadata",
  "github.issue.read": "Issues",
  "github.pull_request.read": "Pull requests",
  "github.comment.read": "Comments",
  "github.review.read": "Reviews",
  "github.discussion.read": "Discussions",
  "github.check.read": "Checks",
  "github.contents.read": "Repository contents",
  "github.commit.read": "Commits",
  "github.release.read": "Releases",
};

export const workspaceLabels: Record<WorkspaceCapability, string> = {
  "workspace.fs.read": "Read workspace files",
  "workspace.fs.write": "Write workspace files",
  "workspace.git.read": "Read local Git state",
  "workspace.git.write-local": "Write local Git state",
  "workspace.exec.shell": "Run shell commands",
  "workspace.exec.javascript": "Run JavaScript",
  "workspace.exec.container": "Run containers",
  "workspace.network.connect": "Connect to the network",
  "workspace.dependencies.install": "Install dependencies",
  "workspace.artifacts.publish": "Publish artifacts",
};
