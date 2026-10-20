import {
  authoredTriggerSubject,
  authorPermissionV1Schema,
  maintainerAssociations,
  starterSubject,
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

/** The OIDC actor of the run, as the runner environment names it (`GITHUB_ACTOR`, `GITHUB_ACTOR_ID`). */
export interface RunActor {
  readonly login: string | undefined;
  readonly id: string | undefined;
}

/**
 * The login whose repository permission decides whether the run's starter is
 * trusted: the actor, when it is someone other than the subject's author (the
 * labeller of an issue, say). Null whenever the Worker can decide without it:
 * schedules, manual runs, pushes and `synchronize` decide from the event, and
 * an actor who is the author is judged by the author's own association and
 * permission. Bots (`name[bot]`) are never looked up: the Worker never trusts
 * them. An actor the environment does not name fully is not looked up either,
 * which fails closed, because the Worker then treats the starter as untrusted.
 */
export function actorPermissionLogin(event: RunnerEventV1, actor: RunActor): string | null {
  // Kinds in `starterDecidingKinds` have no entry, so they are never looked up.
  const key = (starterSubject as Record<string, string | undefined>)[event.kind];
  if (key === undefined) return null;
  const subject = (event as Record<string, unknown>)[key] as { author?: { id?: unknown } } | undefined;
  if (subject === null || typeof subject !== "object") return null;
  if (actor.login === undefined || !LOGIN.test(actor.login)) return null;
  if (actor.id === undefined || !/^[1-9][0-9]{0,19}$/.test(actor.id)) return null;
  return subject.author?.id === actor.id ? null : actor.login;
}

/**
 * The event with the actor's looked-up permission. Fails closed like
 * `withAuthorPermission`: the event comes back unchanged if it would not parse.
 */
export function withActorPermission(event: RunnerEventV1, permission: AuthorPermissionV1): RunnerEventV1 {
  const parsed = runnerEventV1Schema.safeParse({ ...event, actorPermission: permission });
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
