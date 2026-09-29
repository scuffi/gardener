import {
  authoredTriggerSubject,
  authorPermissionV1Schema,
  maintainerAssociations,
  type AuthorPermissionV1,
} from "@gardener/contracts";
import { runnerEventV1Schema, type RunnerEventV1 } from "@gardener/protocol";
import { readBoundedBody } from "./github-read";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A user login. App bots (`name[bot]`) never match, and are never looked up. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

type Subject = { author?: { login?: unknown }; authorAssociation?: string };

function subjectOf(event: RunnerEventV1): { key: string; subject: Subject } | null {
  const key = (authoredTriggerSubject as Record<string, string | undefined>)[event.kind];
  if (key === undefined) return null;
  const subject = (event as Record<string, unknown>)[key];
  return subject !== null && typeof subject === "object" ? { key, subject: subject as Subject } : null;
}

/**
 * The login whose repository permission `authors: maintainers` needs: the
 * author of the text an authored trigger names. Null when the event has no
 * such text, or its association already counts, so most runs make no call.
 */
export function authorPermissionLogin(event: RunnerEventV1): string | null {
  const found = subjectOf(event);
  if (found === null) return null;
  const association = found.subject.authorAssociation;
  if (association !== undefined && (maintainerAssociations as readonly string[]).includes(association)) return null;
  const login = found.subject.author?.login;
  return typeof login === "string" && LOGIN.test(login) ? login : null;
}

/**
 * The event with the looked-up permission beside that subject's association.
 * Like the lookup, it fails closed: the event is returned unchanged if the
 * result would not parse.
 */
export function withAuthorPermission(event: RunnerEventV1, permission: AuthorPermissionV1): RunnerEventV1 {
  const found = subjectOf(event);
  if (found === null) return event;
  const parsed = runnerEventV1Schema.safeParse({ ...event, [found.key]: { ...found.subject, authorPermission: permission } });
  return parsed.success ? parsed.data : event;
}

/**
 * Reads the author's effective permission on the run's own repository with the
 * read-only planning token (it needs only Metadata: read). Fails closed: any
 * error gives null, and the run then falls back to the association alone.
 */
export async function fetchAuthorPermission(input: {
  repository: string;
  login: string;
  token: string;
  fetch?: typeof fetch;
}): Promise<AuthorPermissionV1 | null> {
  if (!input.token || !LOGIN.test(input.login)) return null;
  if (!REPOSITORY.test(input.repository) || input.repository.split("/").some((part) => part === "." || part === "..")) {
    return null;
  }
  try {
    const response = await (input.fetch ?? fetch)(
      `https://api.github.com/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}/collaborators/${encodeURIComponent(input.login)}/permission`,
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
    const value = JSON.parse(body.text) as { permission?: unknown };
    const parsed = authorPermissionV1Schema.safeParse(value.permission);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
