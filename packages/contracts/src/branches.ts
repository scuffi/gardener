import { z } from "zod";
import { isValidGitBranchName, type OperationKind } from "./operations";

/**
 * Effect kinds that write to a named branch, and the payload field naming it.
 * Each may carry its own `branches:` option; without one it is confined to
 * `gardener/**`.
 */
export const branchWriteFields = {
  "branch.create": "branch",
  "commit.create": "branch",
  "pull_request.open": "head",
  "pull_request.open_draft": "head",
} as const satisfies Partial<Record<OperationKind, string>>;
export type BranchWriteKind = keyof typeof branchWriteFields;
export const branchWriteKinds = Object.keys(branchWriteFields) as BranchWriteKind[];

export function isBranchWriteKind(kind: string): kind is BranchWriteKind {
  return Object.hasOwn(branchWriteFields, kind);
}

/** Where a task may write when its effect entry names no branches. */
export const DEFAULT_WRITE_BRANCHES: readonly string[] = Object.freeze(["gardener/**"]);

const MAX_BRANCH_PATTERNS = 20;

/**
 * A branch name in which a segment may be `**` (one or more whole segments)
 * and other segments may use `*` (any characters within that segment).
 */
export function isValidBranchPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 255) return false;
  const segments = pattern.split("/");
  if (segments.some((segment) => segment.includes("**") && segment !== "**")) return false;
  // With wildcards replaced by an ordinary character, what remains must be a
  // valid branch name, so a pattern can only ever describe real branches.
  return isValidGitBranchName(segments.map((segment) => segment.replaceAll("*", "x")).join("/"));
}

export const branchPatternSchema = z.string().trim().min(1).max(255)
  .refine(isValidBranchPattern, "branch patterns are branch names whose segments may use * or be **");
export const branchPatternsSchema = z.array(branchPatternSchema).min(1).max(MAX_BRANCH_PATTERNS)
  .refine((patterns) => new Set(patterns).size === patterns.length, "branch patterns must be unique");

/** Whether one branch segment matches one pattern segment, where `*` matches any run of characters. */
function segmentMatches(patternText: string, segmentText: string): boolean {
  // Dynamic programming rather than a regular expression, so a pattern with
  // many wildcards costs at most pattern length times segment length. Both
  // sides are compared by code point, so characters outside the BMP match.
  const pattern = [...patternText];
  const segment = [...segmentText];
  let previous = new Array<boolean>(segment.length + 1).fill(false);
  previous[0] = true;
  for (const character of pattern) {
    const current = new Array<boolean>(segment.length + 1).fill(false);
    if (character === "*") {
      let reachable = false;
      for (let index = 0; index <= segment.length; index++) {
        reachable ||= previous[index]!;
        current[index] = reachable;
      }
    } else {
      for (let index = 1; index <= segment.length; index++) {
        current[index] = previous[index - 1]! && segment[index - 1] === character;
      }
    }
    previous = current;
  }
  return previous[segment.length]!;
}

/**
 * Matches segment by segment: `**` consumes one or more whole segments. The
 * branch side is model-chosen, so this must stay polynomial for any input the
 * schemas admit; a compiled regular expression with several `**` backtracks.
 */
export function branchPatternMatches(pattern: string, branch: string): boolean {
  const patternSegments = pattern.split("/");
  const branchSegments = branch.split("/");
  // matched[j]: the pattern segments so far match the first j branch segments.
  let matched = new Array<boolean>(branchSegments.length + 1).fill(false);
  matched[0] = true;
  for (const patternSegment of patternSegments) {
    const next = new Array<boolean>(branchSegments.length + 1).fill(false);
    if (patternSegment === "**") {
      let reachable = false;
      for (let index = 1; index <= branchSegments.length; index++) {
        reachable ||= matched[index - 1]!;
        next[index] = reachable;
      }
    } else {
      for (let index = 1; index <= branchSegments.length; index++) {
        next[index] = matched[index - 1]! && segmentMatches(patternSegment, branchSegments[index - 1]!);
      }
    }
    matched = next;
  }
  return matched[branchSegments.length]!;
}

/**
 * Whether a task may write to `branch`. A wildcard never matches the default
 * branch: writing straight to it needs its exact name in the list.
 */
export function branchAllowed(branch: string, patterns: readonly string[], defaultBranch: string): boolean {
  if (!isValidGitBranchName(branch)) return false;
  if (branch === defaultBranch) return patterns.includes(branch);
  return patterns.some((pattern) => branchPatternMatches(pattern, branch));
}

/** Why `branch` is refused, or `undefined` when the patterns allow it. */
export function branchWriteRefusal(
  kind: BranchWriteKind,
  branch: string,
  patterns: readonly string[],
  defaultBranch: string,
): string | undefined {
  if (branchAllowed(branch, patterns, defaultBranch)) return undefined;
  const field = branchWriteFields[kind];
  const allowed = patterns.join(", ");
  return branch === defaultBranch
    ? `${kind} ${field} ${branch} is the default branch, which this task may write only if its branches list names it exactly (allowed: ${allowed})`
    : `${kind} ${field} ${branch} is outside this task's branches (allowed: ${allowed})`;
}

interface CommitBaseStep {
  readonly stepName: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly references: Readonly<Record<string, unknown>>;
}

/**
 * A commit is built from the captured working tree, so it must sit directly on
 * the captured commit: otherwise files the task never saw change would be
 * written over whatever the branch holds. `expectedHeadSha` must be that
 * commit, or come from a `branch.create` made from it. Returns why not, or
 * `undefined`. A reference this cannot follow is left to apply, which checks
 * the resolved value.
 */
export function commitBaseRefusal(
  commit: CommitBaseStep,
  earlier: readonly CommitBaseStep[],
  captureBaseSha: string,
): string | undefined {
  const reference = commit.references["/expectedHeadSha"];
  if (reference === undefined) {
    const expected = commit.payload.expectedHeadSha;
    return typeof expected === "string" && expected.toLowerCase() === captureBaseSha.toLowerCase()
      ? undefined
      : `commit.create must build on the captured commit ${captureBaseSha}: set expectedHeadSha to it, or to the commitSha of a branch.create made from it`;
  }
  const ref = reference as { step?: unknown; output?: unknown };
  if (typeof ref.step !== "string" || ref.output !== "commitSha") {
    return "commit.create expectedHeadSha may only reference a branch.create step's commitSha";
  }
  const source = earlier.find((step) => step.stepName === ref.step);
  if (source === undefined || source.kind !== "branch.create") {
    return "commit.create expectedHeadSha may only reference a branch.create step's commitSha";
  }
  if (source.references["/fromSha"] !== undefined) return undefined;
  const from = source.payload.fromSha;
  return typeof from === "string" && from.toLowerCase() === captureBaseSha.toLowerCase()
    ? undefined
    : `branch.create step ${source.stepName} must start from the captured commit ${captureBaseSha} for commit.create to build on it`;
}
