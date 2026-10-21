/**
 * Sends a plan's message after every operation applied.
 *
 * A sibling of `github-effects.ts` that never shares its context: the only
 * GitHub call here is a read of the message's subject, and the only other
 * call goes to the chat destination. The destination comes from the apply
 * step's `chat-webhook` input alone, never from the plan, so the model can
 * neither choose where a message goes nor learn it. Nothing here logs,
 * records or reports the destination or any part of it.
 *
 * A plan's Google Chat message reaches the space at most once: each post carries a
 * `messageId` derived from the plan's digest, and Chat refuses a second post
 * with that id (409 ALREADY_EXISTS), which counts as sent. Slack has no such
 * key, so its delivery is at least once: a crash between the POST and the
 * receipt, or a timeout after Slack accepted it, can post twice on a rerun.
 */
import { createHash } from "node:crypto";
import {
  isMessageInvisibleCharacter,
  isMessageMarkupCharacter,
  messageSubjectNumber,
  type MessageV1,
  type TaskEffectPlanV1,
} from "@gardener/contracts";
import type { RunnerMessageReceiptV1, RunnerPlanStepReceiptV1 } from "@gardener/protocol";
import { readBoundedBody } from "./github-read";

export type MessageTransportId = NonNullable<RunnerMessageReceiptV1["transport"]>;

/** Everything a transport renders, already read from GitHub by trusted code. Provider-neutral. */
export interface RenderedMessageInput {
  /** The subject's own GitHub web URL, checked to be in this repository. */
  subjectUrl: string;
  /** `owner/repo#N`. */
  subjectLabel: string;
  title: string;
  /** The subject author's login. */
  author: string;
  summary: string;
}

/**
 * One kind of chat destination. `render` owns the product's escaping and
 * limits, so each product's quirks live with it; a future transport (a Chat
 * SDK adapter with bot credentials, say) plugs in here with contracts, the
 * Worker and tasks unchanged.
 */
export interface MessageTransport {
  readonly id: MessageTransportId;
  render(message: RenderedMessageInput): { body: unknown; text: string };
  /**
   * Posts the rendered body. `messageKey` is the same for every attempt at
   * this plan's message, so a transport whose service deduplicates on a
   * client key can make a rerun harmless.
   */
  send(body: unknown, signal: AbortSignal, messageKey: string): Promise<void>;
}

/**
 * The key every attempt at a plan's message shares: lowercase hex from the
 * plan artifact's SHA-256, which apply verified and the receipt already
 * records, so it reveals nothing new. Domain-separated so it is not the
 * digest itself. 56 characters, so Google Chat's `client-` id fits in 63.
 */
export function messageKey(planDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(planDigest)) throw new Error("message key needs the plan's SHA-256 digest");
  return createHash("sha256").update(`gardener.message-key/v1\n${planDigest}`).digest("hex").slice(0, 56);
}

/** Google Chat's client-assigned message id: `client-` and at most 56 of `[a-z0-9-]`, 63 in all. */
export function googleChatMessageId(key: string): string {
  if (!/^[0-9a-f]{1,56}$/.test(key)) throw new Error("Google Chat message ids take a lowercase hex key of at most 56 characters");
  return `client-${key}`;
}

/** A send the chat service refused or never answered. Its message never contains the destination. */
export class MessageSendError extends Error {}

const TITLE_MAX_CHARACTERS = 200;
const ERROR_DETAIL_MAX_CHARACTERS = 200;
const MAX_RESPONSE_BYTES = 64 * 1024;
const GITHUB_TIMEOUT_MS = 10_000;

/** Safe lookalikes for the characters a chat service treats as markup. `&` is left to the transport. */
const LOOKALIKES: Readonly<Record<string, string>> = { "<": "‹", ">": "›", "`": "ʼ" };

/**
 * Text as one inert line: all whitespace (newlines and U+2028/U+2029 included)
 * collapsed to single spaces, invisible characters dropped, `<`, `>` and
 * backticks replaced with lookalikes, and at most `maxCharacters` code points,
 * so a surrogate pair is never split. Uses the same predicates as the
 * proposal's summary refusal, so the two cannot drift.
 */
export function sanitizeMessageText(text: string, maxCharacters?: number): string {
  const characters = Array.from(text.replace(/\s+/gu, " "))
    .filter((character) => !isMessageInvisibleCharacter(character))
    .map((character) => isMessageMarkupCharacter(character) ? LOOKALIKES[character] ?? character : character);
  const flat = characters.join("").replace(/ {2,}/g, " ").trim();
  const kept = Array.from(flat);
  if (maxCharacters === undefined || kept.length <= maxCharacters) return flat;
  return `${kept.slice(0, maxCharacters - 1).join("").trimEnd()}…`;
}

/**
 * The text both products accept: one link, built by Gardener to the subject's
 * own GitHub URL, then the title and summary inside inline code spans, which
 * neither product formats, autolinks or treats as mentions. `escape` is the
 * transport's own escaping of the untrusted parts.
 */
function messageText(message: RenderedMessageInput, escape: (text: string) => string): string {
  const title = sanitizeMessageText(message.title, TITLE_MAX_CHARACTERS) || "(untitled)";
  const author = sanitizeMessageText(message.author, 100) || "unknown";
  const summary = sanitizeMessageText(message.summary) || "(no summary)";
  return `<${message.subjectUrl}|${escape(message.subjectLabel)}> \`${escape(title)}\` (@${escape(author)})\n\`${escape(summary)}\``;
}

/**
 * POSTs `body` to `url`, which is the destination, possibly with a non-secret
 * query parameter appended. Anything the service says is scrubbed of the
 * destination, which holds every secret part of `url`.
 * `alreadyDone` lets a transport count a refusal as success, from the status
 * and the bounded body.
 */
async function postJson(input: {
  fetchImpl: typeof fetch;
  destination: string;
  url: string;
  body: unknown;
  signal: AbortSignal;
  alreadyDone?: (status: number, text: string) => boolean;
}): Promise<void> {
  const { fetchImpl, destination, url, body, signal } = input;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch (error) {
    // Fetch errors can quote the URL, so only the error's kind is reported.
    const kind = error instanceof Error ? error.name : "error";
    throw new MessageSendError(`the chat service could not be reached (${kind})`);
  }
  if (response.ok) return;
  let detail = "";
  try {
    const text = (await readBoundedBody(response, MAX_RESPONSE_BYTES)).text;
    if (input.alreadyDone?.(response.status, text)) return;
    detail = scrubDestination(text, destination).replace(/\s+/g, " ").trim().slice(0, ERROR_DETAIL_MAX_CHARACTERS);
  } catch {
    // The status alone is enough to act on.
  }
  throw new MessageSendError(`the chat service answered ${response.status}${detail ? `: ${detail}` : ""}`);
}

/**
 * Removes the destination from a service's error text: the whole URL, its
 * query string and each query value, and every path segment long enough to be
 * a token (Slack's webhook path is its secret).
 */
export function scrubDestination(text: string, destination: string): string {
  const url = new URL(destination);
  const secrets = new Set<string>([destination, `${url.origin}${url.pathname}`, url.search.slice(1)]);
  for (const value of url.searchParams.values()) secrets.add(value);
  for (const segment of url.pathname.split("/")) if (segment.length >= 8) secrets.add(segment);
  let scrubbed = text;
  for (const secret of [...secrets].filter((value) => value.length >= 4).sort((left, right) => right.length - left.length)) {
    scrubbed = scrubbed.split(secret).join("***");
  }
  return scrubbed;
}

/**
 * Google Chat incoming webhook. Chat does not decode HTML entities in `text`,
 * so `&` needs no escaping here; `<` and `>` are already gone from the
 * untrusted parts.
 *
 * Each post carries `messageId=client-<key>`. Incoming webhooks honour it
 * (checked against a live space): a second post with the same id is refused
 * with 409 ALREADY_EXISTS and posts nothing, so that refusal means an earlier
 * attempt was delivered, and counts as sent.
 */
function googleChatTransport(destination: string, fetchImpl: typeof fetch): MessageTransport {
  return {
    id: "google-chat-webhook",
    render(message) {
      const text = messageText(message, (value) => value);
      return { body: { text }, text };
    },
    send: (body, signal, key) => postJson({
      fetchImpl,
      destination,
      url: withQueryParameter(destination, "messageId", googleChatMessageId(key)),
      body,
      signal,
      alreadyDone: (status, text) => status === 409 && googleErrorStatus(text) === "ALREADY_EXISTS",
    }),
  };
}

/**
 * Appends one parameter. Re-serializing the URL keeps the key and token of
 * every real Google Chat and Slack webhook as given; only characters those
 * never contain (a space, `<`) would be re-encoded.
 */
function withQueryParameter(destination: string, name: string, value: string): string {
  const url = new URL(destination);
  const parameter = `${name}=${value}`;
  url.search = url.search.length > 1 ? `${url.search.slice(1)}&${parameter}` : parameter;
  return url.toString();
}

/** The `error.status` of a Google API error body, if it is one. */
function googleErrorStatus(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { status?: unknown } };
    return typeof parsed.error?.status === "string" ? parsed.error.status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Slack incoming webhook. Slack decodes `&lt;`, `&gt;` and `&amp;` before it
 * parses mrkdwn, so `&` is escaped first, then `<` and `>`; otherwise a title
 * reading `&lt;!channel&gt;` would become a real `<!channel>`.
 */
function slackTransport(destination: string, fetchImpl: typeof fetch): MessageTransport {
  return {
    id: "slack-webhook",
    render(message) {
      const text = messageText(message, (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
      return { body: { text }, text };
    },
    // Slack incoming webhooks take no client key, so a rerun can post twice.
    send: (body, signal) => postJson({ fetchImpl, destination, url: destination, body, signal }),
  };
}

/**
 * The transport for a destination, or `undefined` when it is not a supported
 * incoming-webhook URL. The only place a destination is inspected: an `https:`
 * URL with no credentials or port whose host is exactly a supported service's,
 * so `hooks.slack.com.evil.example` matches nothing.
 */
export function transportFor(destination: string, fetchImpl: typeof fetch = fetch): MessageTransport | undefined {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  if (url.hostname === "chat.googleapis.com") return googleChatTransport(destination, fetchImpl);
  if (url.hostname === "hooks.slack.com") return slackTransport(destination, fetchImpl);
  return undefined;
}

/** The subject as apply reads it now, with the apply token. */
export interface MessageSubjectRead {
  updatedAt: string;
  title: string;
  url: string;
  author: string;
}

const DISCUSSION_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    discussion(number:$number){ updatedAt title url author{ login } }
  }
}`;

/** Reads the subject, or `null` when it cannot be read or parsed. */
export async function readMessageSubject(input: {
  repository: string;
  subject: MessageV1["subject"];
  token: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<MessageSubjectRead | null> {
  const [owner, name] = input.repository.split("/") as [string, string];
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.token}`,
    "user-agent": "gardener-runner",
    "x-github-api-version": "2022-11-28",
  };
  const signal = input.signal ?? AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  try {
    const repoPath = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    let value: Record<string, unknown> | undefined;
    if (input.subject.kind === "discussion") {
      const response = await (input.fetch ?? fetch)("https://api.github.com/graphql", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ query: DISCUSSION_QUERY, variables: { owner, name, number: input.subject.discussionNumber } }),
        redirect: "error",
        signal,
      });
      if (!response.ok) return null;
      const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      if (body.truncated) return null;
      const discussion = (JSON.parse(body.text) as { data?: { repository?: { discussion?: Record<string, unknown> | null } } })
        .data?.repository?.discussion;
      if (!discussion) return null;
      value = { updated_at: discussion.updatedAt, title: discussion.title, html_url: discussion.url, user: discussion.author };
    } else {
      const path = input.subject.kind === "issue" ? `issues/${input.subject.issueNumber}` : `pulls/${input.subject.pullNumber}`;
      const response = await (input.fetch ?? fetch)(`${repoPath}/${path}`, { headers, redirect: "error", signal });
      if (!response.ok) return null;
      const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      if (body.truncated) return null;
      value = JSON.parse(body.text) as Record<string, unknown>;
    }
    const user = value.user as { login?: unknown } | null | undefined;
    if (typeof value.updated_at !== "string" || typeof value.title !== "string" || typeof value.html_url !== "string") return null;
    return {
      updatedAt: value.updated_at,
      title: value.title,
      url: value.html_url,
      author: typeof user?.login === "string" ? user.login : "ghost",
    };
  } catch {
    return null;
  }
}

/** The subject's own web URL in this repository, so the one link a message carries can't point elsewhere. */
export function subjectUrlInRepository(url: string, repository: string, subject: MessageV1["subject"]): boolean {
  const section = subject.kind === "issue" ? "(?:issues|pull)" : subject.kind === "pull_request" ? "pull" : "discussions";
  const match = new RegExp(`^https://github\\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/${section}/([1-9][0-9]*)$`).exec(url);
  return match !== null && match[1]!.toLowerCase() === repository.toLowerCase() && Number(match[2]) === messageSubjectNumber(subject);
}

/** Resource keys an operation on this subject records its version under. A pull request is also an issue. */
function subjectResourceKeys(subject: MessageV1["subject"]): string[] {
  const number = messageSubjectNumber(subject);
  return subject.kind === "discussion" ? [`discussion:${number}`] : [`issue:${number}`, `pull:${number}`];
}

/** Whether a message on this resource will need the version a step leaves it at. */
export function messageMayTarget(plan: Pick<TaskEffectPlanV1, "messages">, resource: string): boolean {
  return (plan.messages ?? []).some((message) => subjectResourceKeys(message.subject).includes(resource));
}

/**
 * The version this plan's own last write left the subject at, from the
 * receipt. A message pinned before those writes still accepts it, as a later
 * operation on the same resource does, and nothing else.
 */
function ownSubjectVersion(operations: readonly RunnerPlanStepReceiptV1[], subject: MessageV1["subject"]): string | undefined {
  const keys = subjectResourceKeys(subject);
  return operations
    .filter((step) => step.receipt.status === "succeeded" && step.resourceVersion !== undefined && keys.includes(step.resourceVersion.resource))
    .at(-1)?.resourceVersion?.updatedAt;
}

function sameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  return Number.isFinite(leftMs) && leftMs === Date.parse(right);
}

function expectedUpdatedAt(subject: MessageV1["subject"]): string {
  return subject.kind === "issue"
    ? subject.expectedIssueUpdatedAt
    : subject.kind === "pull_request" ? subject.expectedPullUpdatedAt : subject.expectedDiscussionUpdatedAt;
}

/** What became of the plan's message, and what the job summary says about it. */
export interface MessageOutcome {
  receipt: RunnerMessageReceiptV1;
  /** The text sent, for a sent message only. */
  text?: string;
  /** Why it failed, for a failed message only. Never contains the destination. */
  error?: string;
  /** True when a prior receipt already settled it and nothing was tried. */
  settled?: boolean;
}

/**
 * Sends the plan's message once its operations applied, or settles it
 * without sending: skipped without a usable destination, conflicted when the
 * subject changed or moved, failed when it can't be read or sent. A prior
 * `sent`, `skipped` or `conflicted` receipt is final and is returned as-is;
 * a prior `failed` one is tried again.
 */
export async function sendPlanMessage(input: {
  plan: TaskEffectPlanV1;
  /** The operations' receipts, all applied. */
  operations: readonly RunnerPlanStepReceiptV1[];
  /** The message receipt an earlier attempt recorded, if any. */
  prior?: RunnerMessageReceiptV1 | undefined;
  /** The plan artifact's SHA-256, from which every attempt's message key derives. */
  planDigest: string;
  destination: string;
  token: string;
  deadlineAt: number;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<MessageOutcome | undefined> {
  const message = input.plan.messages?.[0];
  if (message === undefined) return undefined;
  const prior = input.prior;
  if (prior !== undefined && prior.status !== "failed") return { receipt: prior, settled: true };
  const now = input.now ?? (() => new Date());
  const base = {
    channel: message.channel,
    subject: { kind: message.subject.kind, number: messageSubjectNumber(message.subject) },
    attemptedAt: now().toISOString(),
  } as const;
  const destination = input.destination.trim();
  if (destination === "") return { receipt: { ...base, status: "skipped", reason: "destination_unset" } };
  const transport = transportFor(destination, input.fetch);
  if (transport === undefined) return { receipt: { ...base, status: "skipped", reason: "destination_unsupported" } };
  const sent = { ...base, transport: transport.id };

  const remaining = () => input.deadlineAt - now().getTime();
  if (remaining() <= 1_000) {
    return { receipt: { ...sent, status: "failed", reason: "deadline_expired" }, error: "the apply job's deadline passed before the message was sent" };
  }
  const subject = await readMessageSubject({
    repository: input.plan.repository.fullName,
    subject: message.subject,
    token: input.token,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    signal: AbortSignal.timeout(Math.min(GITHUB_TIMEOUT_MS, Math.max(1_000, remaining()))),
  });
  if (subject === null) {
    return { receipt: { ...sent, status: "failed", reason: "subject_unreadable" }, error: `${subjectName(message.subject)} could not be read` };
  }
  const own = ownSubjectVersion(input.operations, message.subject);
  if (!sameInstant(subject.updatedAt, expectedUpdatedAt(message.subject)) && (own === undefined || !sameInstant(subject.updatedAt, own))) {
    return { receipt: { ...sent, status: "conflicted", reason: "subject_changed" } };
  }
  if (!subjectUrlInRepository(subject.url, input.plan.repository.fullName, message.subject)) {
    return { receipt: { ...sent, status: "conflicted", reason: "subject_elsewhere" } };
  }
  // An issue number can name a pull request, which GitHub serves through the
  // issues API. The checked link says which it is, so the receipt and the job
  // summary call it what it is.
  const named = { ...sent, subject: { kind: subjectKindFromUrl(subject.url, message.subject.kind), number: sent.subject.number } };
  const rendered = transport.render({
    subjectUrl: subject.url,
    subjectLabel: `${input.plan.repository.fullName}#${messageSubjectNumber(message.subject)}`,
    title: subject.title,
    author: subject.author,
    summary: message.summary,
  });
  if (remaining() <= 1_000) {
    return { receipt: { ...named, status: "failed", reason: "deadline_expired" }, error: "the apply job's deadline passed before the message was sent" };
  }
  try {
    await transport.send(rendered.body, AbortSignal.timeout(Math.min(10_000, Math.max(1_000, remaining()))), messageKey(input.planDigest));
  } catch (error) {
    const reason = error instanceof MessageSendError ? error.message : "the message could not be sent";
    return { receipt: { ...named, status: "failed", reason: "send_failed" }, error: reason };
  }
  return { receipt: { ...named, status: "sent" }, text: rendered.text };
}

/** `pull_request` for an issue subject whose checked link is a pull request's page; otherwise its own kind. */
function subjectKindFromUrl(url: string, kind: MessageV1["subject"]["kind"]): MessageV1["subject"]["kind"] {
  return kind === "issue" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(url) ? "pull_request" : kind;
}

function subjectName(subject: MessageV1["subject"]): string {
  const number = messageSubjectNumber(subject);
  return subject.kind === "issue" ? `Issue #${number}` : subject.kind === "pull_request" ? `Pull request #${number}` : `Discussion #${number}`;
}
