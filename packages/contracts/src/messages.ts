import { z } from "zod";
import { containsReservedOperationMarker } from "./operations";

/**
 * The one declarable effect that is not an operation. A task lists it in
 * `effects:` so authors and reviewers see everything it can do in one place,
 * but it compiles to the plan's `messages`, never to an operation: it writes
 * nothing to the repository and has no operation id, receipt step or token
 * permission of its own.
 */
export const MESSAGE_SEND_KIND = "message.send" as const;
export type MessageSendKind = typeof MESSAGE_SEND_KIND;

/** The most characters (code points) a message summary may carry after trimming. */
export const MESSAGE_SUMMARY_MAX_CHARACTERS = 400;

/**
 * Characters a chat service may act on without showing them: controls, format
 * characters (bidi overrides, zero-width joiners), and line and paragraph
 * separators. One predicate for both the proposal's refusal and the runner's
 * render-time sanitizer, so the two cannot drift.
 *
 * This includes U+200D ZERO WIDTH JOINER, so a ZWJ emoji sequence in a title
 * renders as its component emoji. That is deliberate: a joiner is invisible
 * too, and exempting it would need a grapheme-aware rule for one cosmetic case.
 */
export function isMessageInvisibleCharacter(character: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character);
}

/**
 * Characters that are markup in a chat service's text: `<` and `>` open Slack
 * links and mentions (`<!channel>`, `<users/all>`), a backtick would end the
 * code span the text is rendered in, and `&` lets Slack decode `&lt;` into a
 * real `<` before it parses mrkdwn.
 */
export function isMessageMarkupCharacter(character: string): boolean {
  return character === "<" || character === ">" || character === "`" || character === "&";
}

/**
 * Why this summary may not be sent, or `undefined`. The summary is model text
 * posted outside the repository, so it is refused rather than repaired: the
 * model hears why and can write it again. Judges the trimmed text, which is
 * what the schema keeps, so a caller that doesn't trim can't pass blank or
 * over-long text by padding.
 */
export function messageSummaryRefusal(summary: string): string | undefined {
  const characters = Array.from(summary.trim());
  if (characters.length === 0) return "summary must not be empty";
  if (characters.length > MESSAGE_SUMMARY_MAX_CHARACTERS) {
    return `summary must be at most ${MESSAGE_SUMMARY_MAX_CHARACTERS} characters, and has ${characters.length}`;
  }
  if (characters.some(isMessageInvisibleCharacter)) {
    return "summary must be one line of plain text: no newlines, control, zero-width or direction characters";
  }
  if (characters.some(isMessageMarkupCharacter)) return "summary must not contain <, >, & or backticks";
  if (containsReservedOperationMarker(summary)) return "summary contains a reserved idempotency marker";
  return undefined;
}

const messageSummaryV1Schema = z.string().trim().superRefine((summary, context) => {
  const refusal = messageSummaryRefusal(summary);
  if (refusal !== undefined) context.addIssue({ code: "custom", message: refusal });
});

const expectedUpdatedAt = z.iso.datetime();
const subjectNumber = z.number().int().positive();

/** What a message may be about: the issue, pull request or discussion it links to. */
export const messageSubjectKindValues = ["issue", "pull_request", "discussion"] as const;
export type MessageSubjectKindV1 = typeof messageSubjectKindValues[number];

/**
 * The payload the model proposes for `message.send`. Like an operation's
 * expected state, `expectedUpdatedAt` comes from the model and apply checks
 * it: if the subject changed since, nothing is sent.
 */
export const messageSendPayloadV1Schema = z.strictObject({
  subject: z.strictObject({
    kind: z.enum(messageSubjectKindValues),
    number: subjectNumber,
    expectedUpdatedAt: expectedUpdatedAt.describe(
      "The subject's updatedAt as you read it: from the normalized event for the triggering issue, pull request or "
        + "discussion, otherwise from provider.api.read. If it changes before apply, nothing is sent.",
    ),
  }),
  summary: messageSummaryV1Schema.describe(
    `One or two plain sentences, at most ${MESSAGE_SUMMARY_MAX_CHARACTERS} characters, without newlines, <, >, & or backticks. `
      + "Gardener adds the link, title and author itself.",
  ),
});
export type MessageSendPayloadV1 = z.infer<typeof messageSendPayloadV1Schema>;

/**
 * One message the apply job sends after every operation succeeded. Nothing
 * here is provider-specific: no destination, host or markup. The destination
 * comes only from the apply job's secret; the transport renders the text.
 */
export const messageV1Schema = z.strictObject({
  /**
   * One destination per repository for now. Named channels come later, and
   * widening this literal is a contract change that needs the same old-pin
   * treatment as the plan's `messages` field itself.
   */
  channel: z.literal("default"),
  subject: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("issue"), issueNumber: subjectNumber, expectedIssueUpdatedAt: expectedUpdatedAt }),
    z.strictObject({ kind: z.literal("pull_request"), pullNumber: subjectNumber, expectedPullUpdatedAt: expectedUpdatedAt }),
    z.strictObject({
      kind: z.literal("discussion"),
      discussionNumber: subjectNumber,
      expectedDiscussionUpdatedAt: expectedUpdatedAt,
    }),
  ]),
  summary: messageSummaryV1Schema,
});
export type MessageV1 = z.infer<typeof messageV1Schema>;

/** The plan's message for a validated `message.send` payload, in the field names operations use. */
export function messageFromSendPayload(payload: MessageSendPayloadV1): MessageV1 {
  const { subject } = payload;
  const bound = subject.kind === "issue"
    ? { kind: "issue" as const, issueNumber: subject.number, expectedIssueUpdatedAt: subject.expectedUpdatedAt }
    : subject.kind === "pull_request"
      ? { kind: "pull_request" as const, pullNumber: subject.number, expectedPullUpdatedAt: subject.expectedUpdatedAt }
      : { kind: "discussion" as const, discussionNumber: subject.number, expectedDiscussionUpdatedAt: subject.expectedUpdatedAt };
  return messageV1Schema.parse({ channel: "default", subject: bound, summary: payload.summary });
}

/** The number a message's subject names, whatever its kind. */
export function messageSubjectNumber(subject: MessageV1["subject"]): number {
  return subject.kind === "issue" ? subject.issueNumber : subject.kind === "pull_request" ? subject.pullNumber : subject.discussionNumber;
}

/** Compact JSON Schema for the `message.send` payload, stated in the trusted prompt. */
export function messageSendPayloadJsonSchema(): string {
  const schema = z.toJSONSchema(messageSendPayloadV1Schema, { unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return JSON.stringify(schema);
}
