import type { DispatchTargetRequest, ResolvedDispatchTarget } from "./event";
import { readBoundedBody } from "./github-read";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;

/**
 * Reads the issue or pull request a manual run targets from the run's own
 * repository. Planning and apply each call this independently, and apply
 * refuses a plan whose target binding differs from what it read.
 */
export async function fetchDispatchTarget(input: {
  target: DispatchTargetRequest;
  repository: string;
  token: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ResolvedDispatchTarget> {
  if (!REPOSITORY.test(input.repository) || input.repository.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("GITHUB_REPOSITORY is not an owner/name slug");
  }
  if (!input.token) throw new Error("A GitHub token is required to read the manual run's target");
  const collection = input.target.kind === "issue" ? "issues" : "pulls";
  const noun = input.target.kind === "issue" ? "issue" : "pull request";
  const response = await (input.fetch ?? fetch)(
    `https://api.github.com/repos/${input.repository}/${collection}/${input.target.number}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "user-agent": "gardener-runner",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (response.status === 404) throw new Error(`${noun} #${input.target.number} was not found in ${input.repository}`);
  if (!response.ok) throw new Error(`Reading ${noun} #${input.target.number} failed (${response.status})`);
  const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
  if (body.truncated) throw new Error(`${noun} #${input.target.number} response is too large`);
  const value = JSON.parse(body.text) as unknown;
  return input.target.kind === "issue" ? { issue: value } : { pull_request: value };
}
