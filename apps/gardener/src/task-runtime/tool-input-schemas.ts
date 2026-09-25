import * as v from "valibot";

const integerInRange = (min: number, max: number, description: string) =>
  v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max), v.description(description));

/**
 * The exact input each repository tool accepts, as the model sees it. The
 * session's `toolAction` and `providerReadAction` take their allowed field
 * lists from here too, so the two cannot drift, and they remain the authority
 * for values and cross-field rules. Because the session's allowlists derive
 * from these schemas, a field added here is accepted there too; the literal
 * key lists pinned in `task-tool-input-schemas.test.ts` are the guard, so keep them. A shared schema used to advertise fields no tool but one
 * accepted, so models called tools with the wrong fields and spent turns
 * retrying.
 *
 * The provider read stays one flat object rather than a union, because some
 * function-calling backends handle a top-level `anyOf` poorly. The session
 * enforces which fields go with which transport.
 */
export const taskToolInputSchemas = {
  repository_read_file: v.strictObject({
    path: v.pipe(v.string(), v.description("Repository-relative path of the file to read.")),
  }),
  repository_list_files: v.strictObject({
    path: v.optional(v.pipe(v.string(), v.description("Repository-relative directory to list, with no leading ./ and no trailing /. Omit it, or use \".\", for the repository root."))),
    maxEntries: v.optional(integerInRange(1, 10_000, "Maximum number of paths to return. Defaults to 1000.")),
  }),
  repository_exec: v.strictObject({
    command: v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1_024), v.description("One shell command to run.")),
    cwd: v.optional(v.pipe(v.string(), v.description("Repository-relative working directory. Defaults to the repository root."))),
    timeoutMs: v.optional(integerInRange(1, 10 * 60_000, "Timeout in milliseconds. Defaults to 30000.")),
    maxOutputBytes: v.optional(integerInRange(1, 4 * 1_024 * 1_024, "Maximum combined output bytes. Defaults to 262144.")),
  }),
  provider_api_read: v.strictObject({
    transport: v.optional(v.pipe(v.picklist(["rest", "graphql"]), v.description("rest (the default) or graphql."))),
    path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2_048), v.description("REST only: API path such as /repos/OWNER/REPO/pulls/1/files."))),
    method: v.optional(v.pipe(v.picklist(["GET", "HEAD"]), v.description("REST only: GET (the default) or HEAD."))),
    query: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32 * 1_024), v.description("GraphQL only: a query document. Mutations are refused."))),
    variables: v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description("GraphQL only: query variables."))),
    operationName: v.optional(v.pipe(v.string(), v.description("GraphQL only: operation to run when the document has several."))),
    timeoutMs: v.optional(integerInRange(1, 10 * 60_000, "Timeout in milliseconds. Defaults to 30000.")),
    maxOutputBytes: v.optional(integerInRange(1, 1_024 * 1_024, "Maximum response bytes. Defaults to 262144.")),
  }),
} as const;

export function taskToolInputSchema(toolName: string) {
  if (!Object.hasOwn(taskToolInputSchemas, toolName)) throw new Error(`Task harness has no input schema for ${toolName}`);
  return taskToolInputSchemas[toolName as keyof typeof taskToolInputSchemas];
}

/** The field names a tool accepts, for the session's exact-key check. */
export function taskToolInputKeys(toolName: keyof typeof taskToolInputSchemas): readonly string[] {
  return Object.keys(taskToolInputSchemas[toolName].entries);
}
