import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { taskEffectPlanV1Schema, type TaskEffectPlanV1 } from "@gardener/contracts";
import type { RunnerPlanStepReceiptV1 } from "@gardener/protocol";
import { isMessageMarkupCharacter } from "@gardener/contracts";
import {
  defangMessageText,
  googleChatMessageId,
  neutralizeLineStart,
  messageEmoji,
  messageKey,
  sanitizeMessageText,
  scrubDestination,
  sendPlanMessage,
  subjectUrlInRepository,
  transportFor,
  type RenderedMessageInput,
} from "../src/messages";
import { renderApplyJobSummary } from "../src/job-summary";

const GOOGLE = "https://chat.googleapis.com/v1/spaces/AAAAsecret/messages?key=KEYVALUE123&token=TOKENVALUE456";
const SLACK = "https://hooks.slack.com/services/T0SECRET1/B0SECRET2/abcdefSECRETxyz";
const PLANNED = "2026-10-21T10:00:00Z";

const input = (overrides: Partial<RenderedMessageInput> = {}): RenderedMessageInput => ({
  emoji: "🐛",
  repositoryName: "repo",
  subjectUrl: "https://github.com/owner/repo/issues/7",
  number: 7,
  title: "App crashes",
  author: "octocat",
  summary: "Crash on start for every user.",
  ...overrides,
});

function plan(extra: Partial<TaskEffectPlanV1> = {}): TaskEffectPlanV1 {
  return taskEffectPlanV1Schema.parse({
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: "repo-123-run-2-attempt-1-plan",
    taskId: "triage",
    taskName: "Triage",
    bundleHash: "a".repeat(64),
    repository: { id: "123", fullName: "owner/repo", defaultBranch: "main" },
    provenance: { sourcePath: ".gardener/tasks/triage/TASK.md", commitSha: "b".repeat(40), workflowRunId: "2", workflowRunAttempt: 1 },
    event: { kind: "github.workflow_dispatch", eventName: "workflow_dispatch", action: null, resource: null, commentId: null },
    limits: {},
    operations: [],
    messages: [{ channel: "default", subject: { kind: "issue", issueNumber: 7, expectedIssueUpdatedAt: PLANNED }, summary: "Crash on start." }],
    ...extra,
  });
}

/** GitHub answers the subject read; the chat service answers with `chat`. */
function service(options: { updatedAt?: string; url?: string; title?: string; labels?: unknown; chat?: Response | Error; read?: number } = {}) {
  const posts: { url: string; body: string; redirect?: RequestRedirect | undefined }[] = [];
  const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url.startsWith("https://api.github.com/")) {
      if (options.read !== undefined) return new Response("{}", { status: options.read });
      return Response.json({
        updated_at: options.updatedAt ?? PLANNED,
        title: options.title ?? "App crashes <users/all>",
        html_url: options.url ?? "https://github.com/owner/repo/issues/7",
        user: { login: "octocat" },
        labels: options.labels ?? [{ name: "bug" }],
      });
    }
    posts.push({ url, body: String(init?.body), redirect: init?.redirect });
    if (options.chat instanceof Error) throw options.chat;
    return options.chat ?? new Response("{}", { status: 200 });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, posts, calls: fetchImpl };
}

const send = (destination: string, fetchImpl: typeof fetch, extra: Partial<Parameters<typeof sendPlanMessage>[0]> = {}) => sendPlanMessage({
  plan: plan(),
  operations: [],
  destination,
  token: "gh-token",
  deadlineAt: Date.now() + 60_000,
  planDigest: "c".repeat(64),
  fetch: fetchImpl,
  ...extra,
});

describe("sanitizing message text", () => {
  it("makes text one inert line, with the same predicates as the summary refusal", () => {
    expect(sanitizeMessageText("a\nb\r\n\tc\u2028d\u2029e")).toBe("a b c d e");
    expect(sanitizeMessageText("zero\u200bwidth\u202eflip\u0000")).toBe("zerowidthflip");
    expect(sanitizeMessageText("<users/all> `x` a&b")).toBe("‹users/all› 'x' a&b");
    expect(sanitizeMessageText("*bold* _it_ ~st~")).toBe("∗bold∗ ˍitˍ ∼st∼");
    expect(sanitizeMessageText("  spaced   out  ")).toBe("spaced out");
  });

  it("replaces every markup character the summary refusal names, except & which each transport handles", () => {
    for (const character of ["<", ">", "`", "&", "*", "_", "~"]) {
      const kept = sanitizeMessageText(`a${character}b`).includes(character);
      expect(kept, character).toBe(character === "&");
    }
    expect(["<", ">", "`", "&"].every(isMessageMarkupCharacter)).toBe(true);
  });

  it("normalizes compatibility forms first, so fullwidth markup and dots are caught", () => {
    const leader = "\u2024";
    expect(sanitizeMessageText("\uFF1Cusers/all\uFF1E \uFF0Abold\uFF0A \uFF3Fit\uFF3F")).toBe("‹users/all› ∗bold∗ ˍitˍ");
    expect(sanitizeMessageText("evil\uFF0Eexample")).toBe(`evil${leader}example`);
    expect(sanitizeMessageText("evil\uFF61example")).toBe(`evil${leader}example`);
    expect(sanitizeMessageText("evil\u3002example")).toBe(`evil${leader}example`);
    // Already defanged text stays defanged: U+2024 normalizes to `.` and is caught again.
    expect(sanitizeMessageText(`evil${leader}example`)).toBe(`evil${leader}example`);
    expect(sanitizeMessageText("ev\u200Bil.example")).toBe(`evil${leader}example`);
  });

  it("defangs internationalized hosts", () => {
    const leader = "\u2024";
    expect(defangMessageText("see пример.рф now")).toBe(`see пример${leader}рф now`);
    expect(defangMessageText("evil.рф")).toBe(`evil${leader}рф`);
    expect(defangMessageText("https://münchen.example/x")).toBe(`https:\u2215\u2215münchen${leader}example/x`);
  });

  it("defangs filenames with TLD-like extensions on purpose, and leaves bare IPv4 and localhost", () => {
    const leader = "\u2024";
    expect(defangMessageText("server.ts and README.md")).toBe(`server${leader}ts and README${leader}md`);
    expect(defangMessageText("192.168.1.1 and 1.2.3.4:8080")).toBe("192.168.1.1 and 1.2.3.4:8080");
    expect(defangMessageText("localhost")).toBe("localhost");
    expect(defangMessageText("http://localhost:3000")).toBe("http:\u2215\u2215localhost:3000");
  });

  it("defangs anything a client could autolink, and leaves prose alone", () => {
    const leader = "\u2024";
    expect(defangMessageText("https://evil.example")).toBe(`https:\u2215\u2215evil${leader}example`);
    expect(defangMessageText("see www.phish.example now")).toBe(`see www${leader}phish${leader}example now`);
    expect(defangMessageText("evil.example/login")).toBe(`evil${leader}example/login`);
    expect(defangMessageText("mail a@b.co")).toBe(`mail a@b${leader}co`);
    expect(defangMessageText("ftp://10.0.0.1/x")).toBe("ftp:\u2215\u221510.0.0.1/x");
    for (const prose of ["Crash on start. Every user, since 2.4.1.", "Fixes #12 for @octocat", "v1.2.3 and node 22.x", "e.g. this, U.S.A.", "Ошибка при запуске. Всегда."]) {
      expect(defangMessageText(prose), prose).toBe(prose);
    }
    expect(sanitizeMessageText("Go to https://evil.example/login now")).not.toMatch(/:\/\/|evil\.example/);
  });

  it("truncates by code points, never splitting a surrogate pair", () => {
    const truncated = sanitizeMessageText("🌱".repeat(300), 200);
    expect(Array.from(truncated)).toHaveLength(200);
    expect(truncated.endsWith("🌱…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(truncated)).toBe(false);
    expect(sanitizeMessageText("short", 200)).toBe("short");
  });
});

describe("transports", () => {
  it("are chosen by exact host on https: URLs only", () => {
    expect(transportFor(GOOGLE)?.id).toBe("google-chat-webhook");
    expect(transportFor(SLACK)?.id).toBe("slack-webhook");
    for (const destination of [
      "http://hooks.slack.com/services/x",
      "https://hooks.slack.com.evil.example/services/x",
      "https://evil.example/hooks.slack.com",
      "https://sub.hooks.slack.com/services/x",
      "https://hooks.slack.com:8443/services/x",
      "https://user:pass@hooks.slack.com/services/x",
      "https://chat.googleapis.com.evil.example/v1",
      "not a url",
      "",
    ]) {
      expect(transportFor(destination), destination).toBeUndefined();
    }
  });

  it("render the notifier format: emoji, repository, one link, author, title, then the summary", () => {
    const { text, body } = transportFor(GOOGLE)!.render(input({ title: "Tracking: response schemas" }));
    expect(text).toBe("🐛 repo <https://github.com/owner/repo/issues/7|#7> (@octocat) - Tracking: response schemas\nCrash on start for every user.");
    expect(body).toEqual({ text });
    expect(text).not.toContain("`");
  });

  const HOSTILE = [
    "<users/all>", "<!channel>", "<https://evil.example|click>", "https://evil.example", "www.phish.example",
    "evil.example/login", "&lt;!channel&gt;", "*bold*", "_it_", "~st~", "`code`", "```block```",
  ];

  it("leave hostile titles and summaries inert in both transports, with Gardener's link the only one", () => {
    for (const hostile of HOSTILE) {
      for (const destination of [GOOGLE, SLACK]) {
        const { text } = transportFor(destination)!.render(input({ title: `x ${hostile} y`, summary: `s ${hostile} t` }));
        const [first, second] = text.split("\n") as [string, string];
        // One `<…|…>` link, the subject's; no formatting characters or URLs after it.
        expect(text.match(/</g), `${hostile} ${destination}`).toHaveLength(1);
        expect(first.startsWith("🐛 repo <https://github.com/owner/repo/issues/7|#7> (@octocat) - "), hostile).toBe(true);
        for (const part of [first.slice(first.indexOf(" - ")), second]) {
          expect(part, `${hostile} ${destination}`).not.toMatch(/[<>*_~`]|:\/\/|evil\.example|phish\.example/);
        }
      }
    }
  });

  it("sanitize the repository name like the title, so it can't format or link either", () => {
    const first = (repositoryName: string, destination = GOOGLE) =>
      transportFor(destination)!.render(input({ repositoryName })).text.split(" <")[0];
    expect(first("my_repo_name")).toBe("🐛 myˍrepoˍname");
    expect(first("docs.rs")).toBe("🐛 docs\u2024rs");
    expect(first("")).toBe("🐛 repository");
    for (const hostile of HOSTILE) {
      for (const destination of [GOOGLE, SLACK]) {
        const { text } = transportFor(destination)!.render(input({ repositoryName: hostile }));
        expect(text.match(/</g), `${hostile} ${destination}`).toHaveLength(1);
        expect(text.split(" <")[0], `${hostile} ${destination}`).not.toMatch(/[<>*_~`]|:\/\/|evil\.example|phish\.example/);
      }
    }
  });

  it("neutralize a list marker at the start of the summary line, and nothing else", () => {
    expect(neutralizeLineStart("- item")).toBe("\u2010 item");
    expect(neutralizeLineStart("+ item")).toBe("\uFE62 item");
    expect(neutralizeLineStart("12. item")).toBe("12\u2024 item");
    for (const plain of ["-item", "1.5 is out", "a - b", "1) item", "no marker"]) expect(neutralizeLineStart(plain), plain).toBe(plain);
    const second = (summary: string) => transportFor(GOOGLE)!.render(input({ summary })).text.split("\n")[1];
    expect(second("- crash on start")).toBe("\u2010 crash on start");
    expect(second("  1. crash")).toBe("1\u2024 crash");
    // The title never starts a line, so it is left alone.
    expect(transportFor(GOOGLE)!.render(input({ title: "- a list?" })).text).toContain(" - - a list?\n");
  });

  it("render the hostile cases exactly as expected", () => {
    const leader = "\u2024";
    const google = (title: string) => transportFor(GOOGLE)!.render(input({ title })).text.split("\n")[0]!.split(" - ")[1];
    expect(google("<users/all>")).toBe("‹users/all›");
    expect(google("https://evil.example")).toBe(`https:\u2215\u2215evil${leader}example`);
    expect(google("www.phish.example")).toBe(`www${leader}phish${leader}example`);
    expect(google("evil.example/login")).toBe(`evil${leader}example/login`);
    expect(google("&lt;!channel&gt;")).toBe("&lt;!channel&gt;");
    expect(google("*bold* _it_ ~st~ `x`")).toBe("∗bold∗ ˍitˍ ∼st∼ 'x'");
  });

  it("escape & first for Slack, so an encoded mention stays text", () => {
    const { text } = transportFor(SLACK)!.render(input({ title: "&lt;!channel&gt; & <!here>", author: "a&b", repositoryName: "r&d" }));
    expect(text).toBe("🐛 r&amp;d <https://github.com/owner/repo/issues/7|#7> (@a&amp;b) - &amp;lt;!channel&amp;gt; &amp; ‹!here›\nCrash on start for every user.");
    expect(text).not.toMatch(/<!/);
  });

  it("truncate the title to 200 characters", () => {
    const { text } = transportFor(GOOGLE)!.render(input({ title: "x".repeat(500) }));
    expect(text).toContain(` - ${"x".repeat(199)}…\n`);
  });
});

describe("the message emoji", () => {
  it("comes from the first telling label, compared case-insensitively and exactly", () => {
    expect(messageEmoji(["Regression", "bug"])).toBe("🔻");
    expect(messageEmoji(["enhancement", "BUG"])).toBe("🐛");
    expect(messageEmoji(["Enhancement"])).toBe("✨");
    expect(messageEmoji(["question"])).toBe("❓");
    expect(messageEmoji(["documentation", "question"])).toBe("❓");
    expect(messageEmoji(["documentation"])).toBe("📚");
    expect(messageEmoji(["bugs", "type: bug", "not-a-regression"])).toBe("🆕");
    expect(messageEmoji([])).toBe("🆕");
  });
});

describe("message keys", () => {
  const digest = "c".repeat(64);

  it("derive one stable, non-secret Google Chat id per plan", () => {
    const key = messageKey(digest);
    expect(key).toMatch(/^[0-9a-f]{56}$/);
    expect(messageKey(digest)).toBe(key);
    expect(messageKey("d".repeat(64))).not.toBe(key);
    // Domain-separated, and pinned: a change would re-send messages already posted.
    expect(key).toBe(createHash("sha256").update(`gardener.message-key/v1\n${digest}`).digest("hex").slice(0, 56));
    expect(key).not.toBe(createHash("sha256").update(digest).digest("hex").slice(0, 56));
    const id = googleChatMessageId(key);
    expect(id).toMatch(/^client-[a-z0-9-]+$/);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toBe(`client-${key}`);
  });

  it("refuse anything but a SHA-256 digest and a short lowercase hex key", () => {
    for (const bad of ["", "C".repeat(64), "c".repeat(63), `${"c".repeat(63)}g`, GOOGLE]) expect(() => messageKey(bad), bad).toThrow();
    expect(() => googleChatMessageId("a".repeat(57))).toThrow();
    expect(() => googleChatMessageId("ABC")).toThrow();
  });
});

describe("subject links", () => {
  it("must be the subject's own page in this repository", () => {
    const issue = { kind: "issue" as const, issueNumber: 7, expectedIssueUpdatedAt: PLANNED };
    expect(subjectUrlInRepository("https://github.com/owner/repo/issues/7", "owner/repo", issue)).toBe(true);
    expect(subjectUrlInRepository("https://github.com/Owner/Repo/pull/7", "owner/repo", issue)).toBe(true);
    expect(subjectUrlInRepository("https://github.com/other/repo/issues/7", "owner/repo", issue)).toBe(false);
    expect(subjectUrlInRepository("https://github.com/owner/repo/issues/8", "owner/repo", issue)).toBe(false);
    expect(subjectUrlInRepository("https://evil.example/owner/repo/issues/7", "owner/repo", issue)).toBe(false);
    expect(subjectUrlInRepository("https://github.com/owner/repo/issues/7?x", "owner/repo", issue)).toBe(false);
    const discussion = { kind: "discussion" as const, discussionNumber: 7, expectedDiscussionUpdatedAt: PLANNED };
    expect(subjectUrlInRepository("https://github.com/owner/repo/discussions/7", "owner/repo", discussion)).toBe(true);
    expect(subjectUrlInRepository("https://github.com/owner/repo/issues/7", "owner/repo", discussion)).toBe(false);
  });
});

describe("sending the plan's message", () => {
  it("skips without a usable destination, without reading or posting", async () => {
    const { fetch, calls } = service();
    expect((await send("", fetch))?.receipt).toMatchObject({ status: "skipped", reason: "destination_unset" });
    expect((await send("https://example.com/hook", fetch))?.receipt).toMatchObject({ status: "skipped", reason: "destination_unsupported" });
    expect((await send("https://example.com/hook", fetch))?.receipt).not.toHaveProperty("transport");
    expect(calls).not.toHaveBeenCalled();
  });

  it("sends the rendered text when the subject is as planned", async () => {
    const { fetch, posts } = service();
    const outcome = await send(GOOGLE, fetch);
    expect(outcome?.receipt).toMatchObject({ channel: "default", subject: { kind: "issue", number: 7 }, transport: "google-chat-webhook", status: "sent" });
    expect(outcome?.receipt).not.toHaveProperty("reason");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body)).toEqual({ text: outcome!.text });
    // A redirect could carry the post somewhere the host check never saw.
    expect(posts[0]!.redirect).toBe("error");
    expect(outcome!.text).toBe("🐛 repo <https://github.com/owner/repo/issues/7|#7> (@octocat) - App crashes ‹users/all›\nCrash on start.");
  });

  it("posts to Google Chat with the plan's message id, leaving the destination's own query as given", async () => {
    // Re-serializing the query would turn `~` into `%7E` and break the token.
    const encoded = "https://chat.googleapis.com/v1/spaces/AAAAsecret/messages?key=KEYVALUE123&token=TOK%3DEN~x";
    const { fetch, posts } = service();
    await send(encoded, fetch);
    await send(encoded, fetch);
    const id = `client-${messageKey("c".repeat(64))}`;
    expect(posts.map((post) => post.url)).toEqual([`${encoded}&messageId=${id}`, `${encoded}&messageId=${id}`]);
    const other = service();
    await send(encoded, other.fetch, { planDigest: "d".repeat(64) });
    expect(other.posts[0]!.url).not.toContain(id);
  });

  it("picks the emoji from the labels read at apply, which include the plan's own", async () => {
    const emoji = async (labels: unknown) => (await send(SLACK, service({ labels }).fetch))?.text?.split(" ")[0];
    expect(await emoji([{ name: "priority: high" }, { name: "Enhancement" }])).toBe("✨");
    expect(await emoji([])).toBe("🆕");
    expect(await emoji("not a list")).toBe("🆕");
    expect(await emoji([null, 3, { name: 4 }, { name: "regression" }])).toBe("🔻");
  });

  it("reads a discussion's labels through GraphQL", async () => {
    const posts: string[] = [];
    let query = "";
    const fetchImpl = (async (request: RequestInfo | URL, init?: RequestInit) => {
      if (String(request) === "https://api.github.com/graphql") {
        query = String(init?.body);
        return Response.json({ data: { repository: { discussion: {
          updatedAt: PLANNED, title: "How do I?", url: "https://github.com/owner/repo/discussions/9",
          author: { login: "asker" }, labels: { nodes: [{ name: "Question" }] },
        } } } });
      }
      posts.push(String(init?.body));
      return new Response("ok");
    }) as typeof fetch;
    const discussionPlan = plan({ messages: [{ channel: "default", subject: { kind: "discussion", discussionNumber: 9, expectedDiscussionUpdatedAt: PLANNED }, summary: "Asked." }] });
    const outcome = await send(SLACK, fetchImpl, { plan: discussionPlan });
    expect(query).toContain("labels(first:100){ nodes{ name } }");
    expect(outcome?.text).toBe("❓ repo <https://github.com/owner/repo/discussions/9|#9> (@asker) - How do I?\nAsked.");
    expect(posts).toHaveLength(1);
  });

  it("posts to Slack at the destination as given, with no key", async () => {
    const { fetch, posts } = service();
    await send(SLACK, fetch);
    expect(posts[0]!.url).toBe(SLACK);
  });

  it("counts Google Chat's 409 ALREADY_EXISTS as sent: an earlier attempt delivered it", async () => {
    const exists = JSON.stringify({ error: { code: 409, message: "Message already exists. Use a different message id.", status: "ALREADY_EXISTS" } });
    const done = await send(GOOGLE, service({ chat: new Response(exists, { status: 409 }) }).fetch);
    expect(done?.receipt).toMatchObject({ status: "sent", transport: "google-chat-webhook" });
    for (const chat of [
      new Response(JSON.stringify({ error: { code: 409, status: "ABORTED" } }), { status: 409 }),
      new Response("ALREADY_EXISTS", { status: 409 }),
      new Response(exists, { status: 400 }),
    ]) {
      expect((await send(GOOGLE, service({ chat }).fetch))?.receipt.status).toBe("failed");
    }
    // Slack has no such key, so a 409 from it is just a failure.
    expect((await send(SLACK, service({ chat: new Response(exists, { status: 409 }) }).fetch))?.receipt.status).toBe("failed");
  });

  it("scrubs the posted URL, message id and all, from a Google Chat error", async () => {
    const id = `client-${messageKey("c".repeat(64))}`;
    const echo = `bad ${GOOGLE}&messageId=${id} path /v1/spaces/AAAAsecret/messages?key=KEYVALUE123&token=TOKENVALUE456&messageId=${id}`;
    const outcome = await send(GOOGLE, service({ chat: new Response(echo, { status: 400 }) }).fetch);
    for (const part of ["KEYVALUE123", "TOKENVALUE456", "AAAAsecret", "chat.googleapis.com", "key="]) expect(outcome?.error).not.toContain(part);
  });

  it("names an issue subject whose link is a pull request as a pull request", async () => {
    const outcome = await send(SLACK, service({ url: "https://github.com/owner/repo/pull/7" }).fetch);
    expect(outcome?.receipt).toMatchObject({ status: "sent", subject: { kind: "pull_request", number: 7 } });
    expect((await send(SLACK, service().fetch))?.receipt.subject).toEqual({ kind: "issue", number: 7 });
    const message = { receipt: outcome!.receipt, text: outcome!.text! };
    expect(renderApplyJobSummary({ plan: plan(), receipt: { ...APPLIED, messages: [message.receipt] }, message }))
      .toContain("**Message** about pull request #7 sent");
  });

  it("conflicts, sending nothing, when the subject changed since planning", async () => {
    const { fetch, posts } = service({ updatedAt: "2026-10-21T10:05:00Z" });
    expect((await send(SLACK, fetch))?.receipt).toMatchObject({ status: "conflicted", reason: "subject_changed", transport: "slack-webhook" });
    expect(posts).toHaveLength(0);
  });

  it("accepts the version the plan's own last write left the subject at", async () => {
    const { fetch, posts } = service({ updatedAt: "2026-10-21T10:05:00Z" });
    const labelled = {
      stepName: "label",
      receipt: {} as RunnerPlanStepReceiptV1["receipt"],
      outputs: {},
      resourceVersion: { resource: "issue:7", updatedAt: "2026-10-21T10:05:00Z" },
    } as RunnerPlanStepReceiptV1;
    labelled.receipt = { status: "succeeded" } as RunnerPlanStepReceiptV1["receipt"];
    expect((await send(SLACK, fetch, { operations: [labelled] }))?.receipt.status).toBe("sent");
    expect(posts).toHaveLength(1);
    const elsewhere = { ...labelled, resourceVersion: { resource: "issue:8", updatedAt: "2026-10-21T10:05:00Z" } };
    expect((await send(SLACK, fetch, { operations: [elsewhere] }))?.receipt.status).toBe("conflicted");
  });

  it("conflicts when the subject's link is not in this repository", async () => {
    const { fetch, posts } = service({ url: "https://github.com/other/repo/issues/7" });
    expect((await send(GOOGLE, fetch))?.receipt).toMatchObject({ status: "conflicted", reason: "subject_elsewhere" });
    expect(posts).toHaveLength(0);
  });

  it("fails when the subject can't be read", async () => {
    const { fetch, posts } = service({ read: 404 });
    const outcome = await send(GOOGLE, fetch);
    expect(outcome?.receipt).toMatchObject({ status: "failed", reason: "subject_unreadable" });
    expect(outcome?.error).toBe("Issue #7 could not be read");
    expect(posts).toHaveLength(0);
  });

  it("fails on a refused send, with the service's answer scrubbed of the destination", async () => {
    const echo = `bad request for ${GOOGLE} key=KEYVALUE123 token TOKENVALUE456 space AAAAsecret`;
    const { fetch } = service({ chat: new Response(echo, { status: 400 }) });
    const outcome = await send(GOOGLE, fetch);
    expect(outcome?.receipt).toMatchObject({ status: "failed", reason: "send_failed", transport: "google-chat-webhook" });
    expect(outcome?.error).toMatch(/^the chat service answered 400: bad request for \*\*\*/);
    for (const part of ["KEYVALUE123", "TOKENVALUE456", "AAAAsecret", "chat.googleapis.com/v1"]) expect(outcome?.error).not.toContain(part);
    const unreachable = await send(SLACK, service({ chat: new TypeError(`fetch failed ${SLACK}`) }).fetch);
    expect(unreachable?.error).toBe("the chat service could not be reached (TypeError)");
  });

  it("follows the prior receipt on a rerun: sent, skipped and conflicted are final, failed retries", async () => {
    for (const status of ["sent", "skipped", "conflicted"] as const) {
      const { fetch, calls } = service();
      const prior = {
        channel: "default" as const, subject: { kind: "issue" as const, number: 7 }, status, attemptedAt: PLANNED,
        ...(status === "skipped" ? { reason: "destination_unset" as const } : { transport: "slack-webhook" as const }),
        ...(status === "conflicted" ? { reason: "subject_changed" as const } : {}),
      };
      const outcome = await send(SLACK, fetch, { prior });
      expect(outcome).toEqual({ receipt: prior, settled: true });
      expect(calls).not.toHaveBeenCalled();
    }
    const { fetch, posts } = service();
    const failed = { channel: "default" as const, subject: { kind: "issue" as const, number: 7 }, transport: "slack-webhook" as const, status: "failed" as const, reason: "send_failed" as const, attemptedAt: PLANNED };
    expect((await send(SLACK, fetch, { prior: failed }))?.receipt.status).toBe("sent");
    expect(posts).toHaveLength(1);
  });

  it("fails without sending once the deadline has passed", async () => {
    const { fetch, calls } = service();
    expect((await send(GOOGLE, fetch, { deadlineAt: Date.now() }))?.receipt).toMatchObject({ status: "failed", reason: "deadline_expired" });
    expect(calls).not.toHaveBeenCalled();
  });

  it("does nothing for a plan without a message", async () => {
    expect(await send(GOOGLE, service().fetch, { plan: plan({ messages: undefined }) })).toBeUndefined();
  });

  it("never echoes the destination in a scrub", () => {
    expect(scrubDestination(`x ${SLACK} T0SECRET1 B0SECRET2 abcdefSECRETxyz`, SLACK)).toBe("x *** *** *** ***");
  });
});

const APPLIED = {
  schemaVersion: "gardener.runner.effect-receipt/v1" as const,
  planRunId: "repo-123-run-2-attempt-1-plan",
  bundleHash: "a".repeat(64),
  artifactSha256: "c".repeat(64),
  plannedOperations: 0,
  status: "applied" as const,
  stoppedAtStep: null,
  operations: [],
};

describe("the apply job summary for a message", () => {
  const applied = {
    schemaVersion: "gardener.runner.effect-receipt/v1" as const,
    planRunId: "repo-123-run-2-attempt-1-plan",
    bundleHash: "a".repeat(64),
    artifactSha256: "c".repeat(64),
    plannedOperations: 0,
    status: "applied" as const,
    stoppedAtStep: null,
    operations: [],
  };
  const base = { channel: "default" as const, subject: { kind: "issue" as const, number: 7 }, attemptedAt: PLANNED };

  it("shows the text sent", () => {
    const text = "<https://github.com/owner/repo/issues/7|owner/repo#7> `t` (@o)\n`s`";
    const message = { receipt: { ...base, transport: "slack-webhook" as const, status: "sent" as const }, text };
    const summary = renderApplyJobSummary({ plan: plan(), receipt: { ...applied, messages: [message.receipt] }, message });
    expect(summary).toContain("✅ Plan applied");
    expect(summary).toContain("**Message** about issue #7 sent (slack-webhook):");
    expect(summary).toContain(text);
    expect(summary).not.toContain("0 of 0 steps");
  });

  it("says why a message was skipped, without a destination", () => {
    const message = { receipt: { ...base, status: "skipped" as const, reason: "destination_unset" as const } };
    const summary = renderApplyJobSummary({ plan: plan(), receipt: { ...applied, messages: [message.receipt] }, message });
    expect(summary).toContain("not sent: GARDENER_CHAT_WEBHOOK is not set");
    expect(summary).not.toMatch(/https:\/\/(hooks|chat)\./);
  });

  it("heads a failed message as such, with its error", () => {
    const message = { receipt: { ...base, transport: "google-chat-webhook" as const, status: "failed" as const, reason: "send_failed" as const }, error: "the chat service answered 500" };
    const summary = renderApplyJobSummary({ plan: plan(), receipt: { ...applied, messages: [message.receipt] }, message, error: "Message not sent: the chat service answered 500" });
    expect(summary).toContain("❌ Plan applied, message not sent");
    expect(summary).toContain("re-run the failed job to try the message again");
    expect(summary).toContain("the chat service answered 500");
    expect(summary).not.toContain("stopped before finishing the plan");
  });
});
