import { runnerEventV1Schema, type RunnerEventV1 } from "@gardener/protocol";
import { readBoundedBody } from "./github-read";

/**
 * A run queued behind an earlier round starts after that round pushed, so the
 * event's pull request head is stale. The reusable workflow checks out the
 * pull request's current head instead, and this confirms it before any task
 * command runs, then plans against it. Apply still refuses any write unless
 * the branch is exactly where the plan expects, so this only decides which
 * commit planning starts from.
 *
 * When the head cannot be confirmed the run stops cleanly rather than failing:
 * review tasks do not trigger on pushes, so no newer run is coming, and a red
 * job would only invite a manual rerun of the same situation.
 */

/** The checked-out head could not be confirmed; the run should stop without failing. */
export class UnconfirmedHeadError extends Error {}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 5_000;

/** The fields of `GET /repos/{owner}/{repo}/pulls/{number}` this check reads. */
export interface CurrentPullRequest {
  state: string;
  updatedAt: string;
  headSha: string;
  headRef: string;
  headRepoId: string | null;
  baseRepoId: string;
}

/**
 * The event to plan against when the workflow checked out `checkoutSha`.
 * Unchanged when that is the event's own head; otherwise the pull request
 * must still be open on the same same-repository branch with `checkoutSha` as
 * its current head, and the event takes that head and its new `updatedAt`.
 */
export function withCurrentPullRequestHead(
  event: RunnerEventV1,
  checkoutSha: string | undefined,
  current: CurrentPullRequest | null,
): RunnerEventV1 {
  const pullRequest = "pullRequest" in event ? event.pullRequest : undefined;
  if (checkoutSha === undefined || pullRequest === undefined || pullRequest.head.sha === checkoutSha) return event;
  const reason = unconfirmedReason(current, checkoutSha, pullRequest.head.ref, pullRequest.base.repo.id);
  const parsed = reason === null && current !== null
    ? runnerEventV1Schema.safeParse({
      ...event,
      pullRequest: { ...pullRequest, updatedAt: current.updatedAt, head: { ...pullRequest.head, sha: checkoutSha } },
    })
    : null;
  if (parsed?.success) return parsed.data;
  throw new UnconfirmedHeadError(
    `Pull request #${pullRequest.number}: the event's head is ${pullRequest.head.sha} and the workflow checked out ${checkoutSha}, `
      + `but ${reason ?? "the current pull request is not a valid event"}.`,
  );
}

function unconfirmedReason(current: CurrentPullRequest | null, checkoutSha: string, headRef: string, baseRepoId: string): string | null {
  if (current === null) return "its current head could not be read";
  if (current.state !== "open") return "it is no longer open";
  if (current.headSha !== checkoutSha) return `its head has moved again, to ${current.headSha}`;
  if (current.headRef !== headRef) return "its head branch changed";
  if (current.headRepoId === null || current.headRepoId !== current.baseRepoId || current.baseRepoId !== baseRepoId) {
    return "only a same-repository pull request can move to its current head";
  }
  return null;
}

/** Reads the pull request now. Null when it cannot be read or parsed. */
export async function fetchCurrentPullRequest(input: {
  repository: string;
  number: number;
  token: string;
  fetch?: typeof fetch;
}): Promise<CurrentPullRequest | null> {
  if (!input.token || !Number.isSafeInteger(input.number) || input.number < 1) return null;
  if (!REPOSITORY.test(input.repository) || input.repository.split("/").some((part) => part === "." || part === "..")) return null;
  try {
    const response = await (input.fetch ?? fetch)(
      `https://api.github.com/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}/pulls/${input.number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "user-agent": "gardener-runner",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    if (body.truncated) return null;
    const value = JSON.parse(body.text) as {
      state?: unknown;
      updated_at?: unknown;
      head?: { sha?: unknown; ref?: unknown; repo?: { id?: unknown } | null };
      base?: { repo?: { id?: unknown } };
    };
    const headRepoId = value.head?.repo?.id;
    const baseRepoId = value.base?.repo?.id;
    if (typeof value.state !== "string" || typeof value.updated_at !== "string"
      || typeof value.head?.sha !== "string" || typeof value.head.ref !== "string"
      || typeof baseRepoId !== "number" || (headRepoId !== undefined && typeof headRepoId !== "number")) {
      return null;
    }
    return {
      state: value.state,
      updatedAt: value.updated_at,
      headSha: value.head.sha,
      headRef: value.head.ref,
      headRepoId: typeof headRepoId === "number" ? String(headRepoId) : null,
      baseRepoId: String(baseRepoId),
    };
  } catch {
    return null;
  }
}
