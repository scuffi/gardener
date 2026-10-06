/**
 * Plain-language explanations for the failures people see in a job summary:
 * what happened and what to do. Matching is on the runtime's own stable
 * messages and the apply bridge's error codes; anything unrecognised gets a
 * generic explanation rather than a guess.
 */

export interface FailureAdvice {
  /** One sentence: what happened, in terms of the task rather than internals. */
  what: string;
  /** One or two sentences: the next step. */
  todo: string;
}

const RERUN_ALL = "To retry now, use **Re-run all jobs**: re-running only the apply job replays the same plan.";

const LIMIT_KEYS: Record<string, string> = {
  "tool-call": "max-tool-calls",
  "model-turn": "max-turns",
  "model-input": "input-tokens",
  "model-output": "output-tokens",
  "model-runtime": "runtime-seconds",
};

/** Advice for a failed or cancelled planning run, from its summary or the bridge's error. */
export function planFailureAdvice(message: string, status: "failed" | "cancelled" = "failed"): FailureAdvice {
  const limit = /^Task (tool-call|model-turn|model-input|model-output|model-runtime) limit was exceeded/.exec(message);
  if (limit) {
    const key = LIMIT_KEYS[limit[1]!]!;
    // The runtime keeps one call back for finish_task, so the trail shows one
    // fewer call than the limit; say so, or the numbers look wrong.
    const reserved = key === "max-tool-calls" ? " The limit includes the final `finish_task` call, so the task's own work gets one fewer." : "";
    return {
      what: `The task reached its own \`${key}\` limit before finishing, so nothing was changed.${reserved}`,
      todo: `Raise \`limits.${key}\` in the task's TASK.md, or narrow its instructions so the model needs less.`,
    };
  }
  if (message.startsWith("Task execution exceeded its runtime deadline") || message.startsWith("Task runtime deadline expired")) {
    return {
      what: "The task ran out of time (`runtime-seconds`) before finishing, so nothing was changed.",
      todo: "Raise `limits.runtime-seconds` in the task's TASK.md, or narrow its instructions.",
    };
  }
  if (message.startsWith("The model stopped without calling finish_task")) {
    return {
      what: "The model stopped without reporting a result, so nothing was changed.",
      todo: "This is often a model running out of output: raise `limits.output-tokens`. If it keeps happening, make the task's instructions end with a clear final step.",
    };
  }
  if (message.startsWith("The model called finish_task more than once")) {
    return { what: "The model reported more than one result, so Gardener refused the run.", todo: "Re-run the workflow; if it repeats, tighten the task's instructions about finishing." };
  }
  const provider = /\(HTTP (\d{3})\)/.exec(message);
  if (/^(The model provider|AI Gateway)/.test(message) && provider) {
    const status = Number(provider[1]);
    if (status >= 500 || status === 408 || status === 429) {
      return { what: "The model provider had a temporary problem, so nothing was changed.", todo: "Re-run all jobs in a few minutes." };
    }
    return {
      what: "The model provider refused the request, so nothing was changed.",
      todo: "An operator should check the installation's AI Gateway provider keys, balance and the task's `model` setting.",
    };
  }
  if (message.includes("AI Gateway could not be reached") || message.includes("AI Gateway is missing")) {
    return { what: "The runtime could not reach its AI Gateway, so nothing was changed.", todo: "An operator should check the AI Gateway configuration and redeploy the runtime." };
  }
  if (message.includes("gardener upgrade --workspace")) {
    return { what: "This repository's workflows and the Gardener runtime are on different releases.", todo: "An operator should follow the instructions in the message below." };
  }
  if (message.startsWith("Repository is not enrolled")) {
    return { what: "This repository is not connected to the Gardener runtime.", todo: "An operator should run `gardener connect`, then let the Gardener sync workflow run on the default branch." };
  }
  if (status === "cancelled" || message.startsWith("GitHub Actions planning job was cancelled") || message.startsWith("Task execution was cancelled")) {
    return {
      what: "The run was cancelled before it finished, so nothing was changed.",
      todo: "Usually a newer run for the same pull request or thread replaced it, and that run carries on. Otherwise re-run the workflow.",
    };
  }
  if (/disconnected|closed before completion|reconnect/i.test(message)) {
    return { what: "The connection to the Gardener runtime dropped and could not be resumed, so nothing was changed.", todo: "Re-run all jobs. If it keeps happening, an operator should check the runtime's health." };
  }
  return {
    what: "Gardener could not finish planning, so nothing was changed.",
    todo: "Re-run all jobs. If it fails again, an operator can see the full record with the command below.",
  };
}

/** Advice for the step that stopped an apply, from its error code. */
export function applyFailureAdvice(code: string): FailureAdvice {
  const notWritten = "Nothing was written for this step or any later step.";
  // Exact codes first: several share a suffix with the families below but
  // mean something different.
  if (INVARIANT_CODES.has(code)) {
    return {
      what: `A Gardener safety check failed, which should not happen. ${notWritten}`,
      todo: "Please report this with the run id below; re-running is unlikely to help.",
    };
  }
  if (code === "review_thread_missing") {
    return {
      what: `The review thread could not be found: it was deleted, or the model named a thread that doesn't exist. ${notWritten}`,
      todo: `If the thread still exists, ${RERUN_ALL.charAt(0).toLowerCase()}${RERUN_ALL.slice(1)}`,
    };
  }
  if (AUTHORITY_CODES.has(code)) {
    return {
      what: `The task tried to write somewhere it is not allowed to (a branch or path outside its \`effects\` options). ${notWritten}`,
      todo: "This repeats on every run until the task's `effects` options or instructions change.",
    };
  }
  if (code === "github_unavailable" || code === "github_graphql_rate_limited") {
    return { what: `GitHub was temporarily unavailable or rate-limited the request. ${notWritten}`, todo: `Wait a few minutes. ${RERUN_ALL}` };
  }
  if (code === "github_pagination_exhausted" || code === "github_response_invalid" || code === "github_tree_truncated") {
    return {
      what: `GitHub returned more data, or a different shape, than Gardener can safely handle. ${notWritten}`,
      todo: "Re-run all jobs; if it repeats, please report it with the run id below.",
    };
  }
  if (code === "effect_deadline_expired") {
    return { what: `The apply job ran out of time. ${notWritten}`, todo: RERUN_ALL };
  }
  if (code.endsWith("_changed") || code.endsWith("_race") || code === "pull_request_mismatch") {
    return {
      what: `The ${subject(code)} changed after Gardener planned this step, usually a new push, comment or edit. ${notWritten}`,
      todo: `The next trigger plans again from the current state. ${RERUN_ALL}`,
    };
  }
  if (code.endsWith("_missing") || code === "account_not_found") {
    return { what: `The ${subject(code)} no longer exists. ${notWritten}`, todo: "Usually nothing to do: it was deleted after planning." };
  }
  if (code.endsWith("_exists")) {
    return { what: `The ${subject(code)} already exists, often from an earlier run. ${notWritten}`, todo: "Check whether an earlier run already did this; if so, nothing more is needed." };
  }
  if (code.endsWith("_locked")) {
    return { what: `The conversation is locked. ${notWritten}`, todo: "Unlock it if Gardener should reply, then re-run all jobs." };
  }
  if (code === "label_not_defined") {
    return { what: `The task tried to add a label the repository doesn't have. ${notWritten}`, todo: "Create the label in the repository, or change the task's instructions." };
  }
  if (code === "merge_method_disabled" || code === "required_checks_incomplete") {
    return { what: `The repository's settings or required checks don't allow this merge yet. ${notWritten}`, todo: "Wait for the checks, or change the merge method the task uses." };
  }
  if (code === "comment_not_owned" || code === "comment_out_of_scope" || code.endsWith("_wrong_pull")) {
    return { what: `The task tried to act on something outside what it may change. ${notWritten}`, todo: "Check the task's instructions; Gardener refused the step rather than guess." };
  }
  if (code.endsWith("_not_applied")) {
    return { what: `GitHub accepted the request but did not apply the change. ${notWritten}`, todo: "Check the repository's settings, then re-run all jobs." };
  }
  if (code.startsWith("github_")) {
    return { what: `GitHub rejected the request. ${notWritten}`, todo: `Check the error below; a 403 usually means the workflow lacks a permission. ${RERUN_ALL}` };
  }
  return { what: `The plan no longer fits the repository. ${notWritten}`, todo: `The next trigger plans again. ${RERUN_ALL}` };
}

/** Codes meaning a Gardener invariant broke, not that the repository changed. */
const INVARIANT_CODES = new Set([
  "canonical_marker_missing",
  "capture_base_missing",
  "capture_content_mismatch",
  "capture_content_unreadable",
  "effect_failed",
]);

/** Deterministic refusals: the plan reached beyond the task's branch or path options. */
const AUTHORITY_CODES = new Set([
  "branch_not_allowed",
  "protected_commit_path",
  "invalid_commit_path",
  "invalid_branch_name",
  "unsafe_path_segment",
  "unsupported_git_object",
]);

function subject(code: string): string {
  const head = code.split("_")[0];
  switch (head) {
    case "pull": return "pull request";
    case "issue": return "issue";
    case "discussion": return "discussion";
    case "comment": case "review": return "comment";
    case "branch": case "head": case "base": return "branch";
    case "release": case "tag": return "release";
    case "check": return "check run";
    default: return "target";
  }
}

/**
 * Splits the runtime's "<message> (<trail>)" failure summary, where the trail
 * reads like "23 tool calls: 12 repository.exec, ...; no effects proposed".
 */
export function splitFailureTrail(summary: string): { message: string; trail?: string } {
  const match = /^([\s\S]*?) \(((?:no tool calls|\d+ tool calls?: [^()]*); (?:no effects proposed|\d+ effects? proposed))\)$/.exec(summary.trim());
  return match ? { message: match[1]!, trail: match[2]! } : { message: summary.trim() };
}
