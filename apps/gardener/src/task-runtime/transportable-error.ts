import { encodeJsonPointer } from "@gardener/contracts";

/**
 * An error that survives the Durable Object RPC boundary with its message.
 *
 * Workers RPC structured-clones thrown errors, and a Zod 4 error keeps its
 * message in an accessor that cloning drops, so the caller received only the
 * name `ZodError`. The model then could not tell which field to fix. Issues are
 * rendered as pointer and message only: Zod messages describe the expected
 * shape, not the rejected value.
 */
export function transportableError(error: unknown): Error {
  const issues = error instanceof Error ? (error as { issues?: unknown }).issues : undefined;
  if (Array.isArray(issues)) {
    const rendered = issues.slice(0, 20).map((issue: { path?: readonly PropertyKey[]; message?: unknown }) =>
      `${encodeJsonPointer(issue.path ?? []) || "/"}: ${typeof issue.message === "string" ? issue.message : "invalid"}`);
    const more = issues.length > 20 ? `; ${issues.length - 20} further problems` : "";
    return new Error(`${rendered.join("; ")}${more}`.slice(0, 4_000));
  }
  // Anything else crosses exactly as before, so callers that branch on an
  // error's type or name after the RPC (AbortError, TimeoutError) are unaffected.
  return error instanceof Error ? error : new Error(String(error));
}
