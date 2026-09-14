import {
  assignmentOverlapWarningV1Schema,
  githubNumericIdSchema,
  operationKindSchema,
  repositoryEventTriggerSchema,
  type AssignmentOverlapWarningV1,
  type OperationKind,
  type RepositoryEventTrigger,
} from "@gardener/contracts";
import { canonicalSha256, deepFreeze } from "./stable";

interface OverlapRevision {
  agentId: string;
  agentDisplayName?: string;
  revisionId: string;
  revisionCompiledHash: string;
  triggers: readonly RepositoryEventTrigger[];
  effects: readonly OperationKind[];
}

export interface OverlapCandidate extends OverlapRevision {
  assignmentId: string;
  assignmentVersion: number;
}

export interface ExistingOverlapAssignment extends OverlapRevision {
  repositoryId: string;
  assignmentId: string;
  assignmentVersion: number;
  enabled: boolean;
}

export interface AnalyzeAssignmentOverlapInput {
  assignmentEpoch: number;
  repositoryId: string;
  candidate: OverlapCandidate;
  existing: readonly ExistingOverlapAssignment[];
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

/** Overlap is advisory. Only shared triggers plus shared persistent effects produce a warning. */
export async function analyzeAssignmentOverlap(input: AnalyzeAssignmentOverlapInput): Promise<Readonly<AssignmentOverlapWarningV1> | null> {
  const repositoryId = githubNumericIdSchema.parse(input.repositoryId);
  if (!Number.isSafeInteger(input.assignmentEpoch) || input.assignmentEpoch < 0) throw new Error("assignmentEpoch must be a non-negative safe integer");
  const candidateTriggers = sortedUnique(input.candidate.triggers.map((trigger) => repositoryEventTriggerSchema.parse(trigger)));
  const candidateEffects = sortedUnique(input.candidate.effects.map((effect) => operationKindSchema.parse(effect)));
  if (candidateTriggers.length === 0 || candidateEffects.length === 0) return null;
  const triggerSet = new Set(candidateTriggers);
  const effectSet = new Set(candidateEffects);
  const conflicts = input.existing.filter((assignment) => assignment.enabled && assignment.repositoryId === repositoryId && assignment.assignmentId !== input.candidate.assignmentId).flatMap((assignment) => {
    const sharedTriggers = sortedUnique(assignment.triggers.filter((trigger) => triggerSet.has(trigger)));
    const sharedEffects = sortedUnique(assignment.effects.filter((effect) => effectSet.has(effect)));
    if (sharedTriggers.length === 0 || sharedEffects.length === 0) return [];
    return [{
      assignmentId: assignment.assignmentId,
      assignmentVersion: assignment.assignmentVersion,
      agentId: assignment.agentId,
      ...(assignment.agentDisplayName === undefined ? {} : { agentDisplayName: assignment.agentDisplayName }),
      activeRevisionId: assignment.revisionId,
      activeRevisionCompiledHash: assignment.revisionCompiledHash,
      sharedTriggers,
      sharedEffects,
    }];
  }).sort((left, right) => left.assignmentId.localeCompare(right.assignmentId) || left.assignmentVersion - right.assignmentVersion || left.activeRevisionCompiledHash.localeCompare(right.activeRevisionCompiledHash));
  if (conflicts.length === 0) return null;
  const candidate = {
    agentId: input.candidate.agentId,
    revisionId: input.candidate.revisionId,
    revisionCompiledHash: input.candidate.revisionCompiledHash,
    assignmentId: input.candidate.assignmentId,
    assignmentVersion: input.candidate.assignmentVersion,
  };
  const fingerprint = await canonicalSha256({ assignmentEpoch: input.assignmentEpoch, candidate, repositoryId, candidateTriggers, candidateEffects, conflicts });
  return deepFreeze(assignmentOverlapWarningV1Schema.parse({ schemaVersion: "v1", assignmentEpoch: input.assignmentEpoch, repositoryId, candidate, conflicts, fingerprint }));
}
