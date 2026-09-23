/**
 * Model-facing read-only GitHub API client.
 *
 * The planning bridge process holds the repository-scoped GitHub token. The
 * model may ask this client to read provider state, but it can never observe,
 * influence, or exfiltrate the token:
 *
 * - the token is private to the client instance and is never returned;
 * - caller-supplied headers cannot set authorization, user-agent, or cookies;
 * - REST is restricted to HTTPS GET/HEAD against api.github.com;
 * - GraphQL accepts query and fragment definitions only, never mutations or
 *   subscriptions;
 * - request and response sizes are bounded, every request carries a bounded
 *   timeout, and responses and transport errors are redacted for the token
 *   before they leave the client.
 *
 * Read authority intentionally covers everything the repository-scoped token
 * can read, not only the enrolled repository.
 */

const GITHUB_API_ORIGIN = "https://api.github.com";
const USER_AGENT = "gardener-read-v1";
const GITHUB_API_VERSION = "2022-11-28";
const REDACTED = "[redacted]";

/** Request headers a task may influence. Everything else is rejected. */
const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "if-none-match",
  "if-modified-since",
]);

/** Response headers returned to the model. Never includes credentials. */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "etag",
  "last-modified",
  "link",
  "retry-after",
  "x-github-api-version-selected",
  "x-github-media-type",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "x-ratelimit-used",
]);

export interface GitHubReadLimits {
  /** Maximum characters in a REST request target. */
  maxRequestTargetLength: number;
  /** Maximum UTF-8 bytes in a GraphQL query document. */
  maxQueryBytes: number;
  /** Maximum UTF-8 bytes in serialized GraphQL variables. */
  maxVariablesBytes: number;
  /** Maximum UTF-8 response bytes retained; the remainder is truncated. */
  maxResponseBytes: number;
  /** Maximum caller-supplied request headers. */
  maxRequestHeaders: number;
  /** Per-request deadline applied in addition to any caller abort signal. */
  requestTimeoutMs: number;
}

export const DEFAULT_GITHUB_READ_LIMITS: GitHubReadLimits = Object.freeze({
  maxRequestTargetLength: 2_048,
  maxQueryBytes: 32 * 1_024,
  maxVariablesBytes: 32 * 1_024,
  maxResponseBytes: 1_024 * 1_024,
  maxRequestHeaders: 8,
  requestTimeoutMs: 30_000,
});

export type GitHubReadFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: "manual";
  signal?: AbortSignal;
}) => Promise<Response>;

export interface GitHubReadClientOptions {
  /** Repository-scoped GitHub token. Never returned or logged. */
  token: string;
  fetch?: GitHubReadFetch;
  limits?: Partial<GitHubReadLimits>;
  signal?: AbortSignal;
}

export interface GitHubRestReadInput {
  /** Absolute api.github.com URL or an origin-relative request target. */
  path: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
}

export interface GitHubGraphQlReadInput {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GitHubReadResult {
  transport: "rest" | "graphql";
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON body when the response is JSON and complete. */
  json: unknown;
  /** Bounded UTF-8 body text. Empty for HEAD responses. */
  body: string;
  /** UTF-8 byte length of `body`, i.e. bytes retained rather than bytes sent. */
  bodyBytes: number;
  truncated: boolean;
}

export class GitHubReadClient {
  readonly #token: string;
  readonly #fetch: GitHubReadFetch;
  readonly #limits: GitHubReadLimits;
  readonly #signal: AbortSignal | undefined;

  constructor(options: GitHubReadClientOptions) {
    const token = options.token;
    if (typeof token !== "string" || token.trim().length < 8 || /[\s\u0000-\u001f\u007f]/.test(token)) {
      throw new Error("A repository-scoped GitHub token is required");
    }
    this.#token = token;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init as RequestInit));
    this.#limits = { ...DEFAULT_GITHUB_READ_LIMITS, ...options.limits };
    this.#signal = options.signal;
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid GitHub read limit ${name}`);
    }
  }

  /** Read any resource the repository-scoped token can read over REST. */
  async rest(input: GitHubRestReadInput): Promise<GitHubReadResult> {
    const method = input.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("The read-only GitHub API permits only GET and HEAD requests");
    }
    const url = this.#resolveRestUrl(input.path);
    const headers = this.#requestHeaders(input.headers, "application/vnd.github+json");
    const response = await this.#send(url, { method, headers, redirect: "manual" });
    return await this.#result("rest", response, method === "HEAD");
  }

  /** Execute a GraphQL query document. Mutations and subscriptions are rejected. */
  async graphql(input: GitHubGraphQlReadInput): Promise<GitHubReadResult> {
    const query = input.query;
    if (typeof query !== "string") throw new Error("GraphQL query must be a string");
    const queryBytes = Buffer.byteLength(query, "utf8");
    if (queryBytes < 1) throw new Error("GraphQL query must not be empty");
    if (queryBytes > this.#limits.maxQueryBytes) throw new Error("GraphQL query exceeds the read size limit");
    assertQueryOnlyDocument(query);

    const payload: Record<string, unknown> = { query };
    if (input.variables !== undefined) {
      if (input.variables === null || typeof input.variables !== "object" || Array.isArray(input.variables)) {
        throw new Error("GraphQL variables must be a JSON object");
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(input.variables);
      } catch {
        throw new Error("GraphQL variables must be JSON-serializable");
      }
      if (serialized === undefined) throw new Error("GraphQL variables must be JSON-serializable");
      if (Buffer.byteLength(serialized, "utf8") > this.#limits.maxVariablesBytes) {
        throw new Error("GraphQL variables exceed the read size limit");
      }
      payload.variables = JSON.parse(serialized) as Record<string, unknown>;
    }
    if (input.operationName !== undefined) {
      if (typeof input.operationName !== "string" || !/^[_A-Za-z][_0-9A-Za-z]{0,127}$/.test(input.operationName)) {
        throw new Error("GraphQL operationName must be a GraphQL name");
      }
      payload.operationName = input.operationName;
    }

    const response = await this.#send(`${GITHUB_API_ORIGIN}/graphql`, {
      method: "POST",
      headers: {
        ...this.#requestHeaders(undefined, "application/json"),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    return await this.#result("graphql", response, false);
  }

  /**
   * Every request carries a bounded deadline composed with any caller signal,
   * and transport failures are re-thrown as redacted Gardener errors so a
   * runtime error string can never carry the authorization header or token.
   */
  async #send(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; redirect: "manual" },
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#limits.requestTimeoutMs);
    const signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout;
    try {
      return await this.#fetch(url, { ...init, signal });
    } catch (error) {
      throw this.#transportError(error);
    }
  }

  #transportError(error: unknown): Error {
    const name = error instanceof Error ? error.name : "Error";
    if (name === "TimeoutError") return new Error("GitHub read request timed out");
    if (name === "AbortError") return new Error("GitHub read request was cancelled");
    const raw = error instanceof Error ? error.message : String(error);
    // Never attach `cause`: a transport error's cause commonly retains the
    // original request, including its authorization header.
    return new Error(`GitHub read request failed: ${this.#redactErrorText(raw).slice(0, 500)}`);
  }

  #resolveRestUrl(rawPath: string): string {
    if (typeof rawPath !== "string" || rawPath.length === 0) throw new Error("GitHub read path is required");
    if (rawPath.length > this.#limits.maxRequestTargetLength) throw new Error("GitHub read path exceeds the read size limit");
    if (/\s/.test(rawPath)) throw new Error("GitHub read path must not contain whitespace");
    if (/[\u0000-\u0020\u007f]/.test(rawPath)) throw new Error("GitHub read path contains control characters");
    if (rawPath.includes("#")) throw new Error("GitHub read path must not contain a fragment");
    if (rawPath.includes("\\")) throw new Error("GitHub read path must not contain backslashes");

    let url: URL;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawPath)) {
      try {
        url = new URL(rawPath);
      } catch {
        throw new Error("GitHub read path is not a valid URL");
      }
    } else {
      if (!rawPath.startsWith("/")) throw new Error("GitHub read path must start with /");
      if (rawPath.startsWith("//")) throw new Error("GitHub read path must not be protocol-relative");
      try {
        url = new URL(rawPath, `${GITHUB_API_ORIGIN}/`);
      } catch {
        throw new Error("GitHub read path is not a valid URL");
      }
    }
    if (url.protocol !== "https:") throw new Error("GitHub read requests must use HTTPS");
    if (url.origin !== GITHUB_API_ORIGIN || url.host !== "api.github.com") {
      throw new Error("GitHub read requests must target api.github.com");
    }
    if (url.username || url.password) throw new Error("GitHub read path must not embed credentials");
    if (url.hash) throw new Error("GitHub read path must not contain a fragment");
    // Check the caller's literal segments as well as the normalized ones: `new URL`
    // silently resolves `..`, so post-normalization inspection alone would accept it.
    const rawSegments = rawPath.split(/[?#]/, 1)[0]!.split("/");
    for (const segment of [...rawSegments, ...url.pathname.split("/")]) {
      const normalized = segment.toLowerCase().replaceAll("%2e", ".");
      if (normalized === "." || normalized === "..") {
        throw new Error("GitHub read path must not contain relative segments");
      }
    }
    const resolved = url.href;
    if (resolved.length > this.#limits.maxRequestTargetLength) throw new Error("GitHub read path exceeds the read size limit");
    return resolved;
  }

  #requestHeaders(caller: Record<string, string> | undefined, defaultAccept: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: defaultAccept,
      "x-github-api-version": GITHUB_API_VERSION,
    };
    if (caller !== undefined) {
      if (caller === null || typeof caller !== "object" || Array.isArray(caller)) {
        throw new Error("GitHub read headers must be an object");
      }
      const entries = Object.entries(caller);
      if (entries.length > this.#limits.maxRequestHeaders) throw new Error("Too many GitHub read headers");
      for (const [rawName, rawValue] of entries) {
        const name = rawName.toLowerCase();
        if (!REQUEST_HEADER_ALLOWLIST.has(name)) throw new Error(`GitHub read header ${name} is not permitted`);
        if (typeof rawValue !== "string" || rawValue.length === 0 || rawValue.length > 1_024) {
          throw new Error(`GitHub read header ${name} has an invalid value`);
        }
        if (/[\u0000-\u001f\u007f]/.test(rawValue)) throw new Error(`GitHub read header ${name} has an invalid value`);
        headers[name] = rawValue;
      }
    }
    // Credentials and identity are always bridge-controlled, never caller-controlled.
    headers.authorization = `Bearer ${this.#token}`;
    headers["user-agent"] = USER_AGENT;
    return headers;
  }

  async #result(transport: "rest" | "graphql", response: Response, headOnly: boolean): Promise<GitHubReadResult> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const key = name.toLowerCase();
      if (RESPONSE_HEADER_ALLOWLIST.has(key)) headers[key] = this.#redactToken(value);
    });
    if (headOnly) {
      // A HEAD response must not carry a body; discard one if a proxy adds it.
      await response.body?.cancel().catch(() => undefined);
      return {
        transport,
        status: response.status,
        ok: response.ok,
        headers,
        json: null,
        body: "",
        bodyBytes: 0,
        truncated: false,
      };
    }
    let read: { text: string; truncated: boolean };
    try {
      read = await readBoundedBody(response, this.#limits.maxResponseBytes);
    } catch (error) {
      throw this.#transportError(error);
    }
    // Full occurrences are replaced outright; a truncation boundary can also
    // split the token, so any trailing partial-token prefix is dropped.
    const body = read.truncated
      ? stripTrailingPrefix(this.#redactToken(read.text), this.#token)
      : this.#redactToken(read.text);
    let json: unknown = null;
    if (!read.truncated && body.length > 0 && isJsonContentType(headers["content-type"])) {
      try {
        json = JSON.parse(body) as unknown;
      } catch {
        json = null;
      }
    }
    return {
      transport,
      status: response.status,
      ok: response.ok,
      headers,
      json,
      body,
      bodyBytes: Buffer.byteLength(body, "utf8"),
      truncated: read.truncated,
    };
  }

  /**
   * Content redaction for response headers and bodies. Only the exact token is
   * replaced, so legitimate provider content that merely discusses
   * authorization headers survives byte-for-byte and stays valid JSON.
   */
  #redactToken(value: string): string {
    return value.includes(this.#token) ? value.split(this.#token).join(REDACTED) : value;
  }

  /**
   * Error-text redaction. Transport errors are free-form diagnostic strings
   * that routinely echo the outgoing request, so in addition to the exact token
   * any `authorization: ...` credential echo is removed.
   *
   * The match deliberately runs to end of line rather than to the next
   * whitespace: a scheme-prefixed value such as `Bearer <secret>` would
   * otherwise leave the secret behind. Losing trailing diagnostic text on that
   * line is the fail-closed trade. This pattern is never applied to response
   * content, where it would corrupt legitimate provider data.
   */
  #redactErrorText(value: string): string {
    return this.#redactToken(value).replace(/authorization:[^\r\n]*/gi, `authorization: ${REDACTED}`);
  }
}

/**
 * Every GraphQL keyword that can begin a top-level definition. Encountering one
 * anywhere other than a definition start means this scanner has lost sync with
 * the real parser, so the document is rejected instead of guessed.
 */
const DEFINITION_KEYWORDS = new Set([
  "query", "mutation", "subscription", "fragment",
  "schema", "type", "interface", "union", "enum", "input", "scalar", "directive", "extend",
]);

/**
 * Conservative, fail-closed GraphQL executable-document classifier.
 *
 * Accepted grammar at definition position (selection-set depth zero):
 *   Document           := Definition+
 *   Definition         := AnonymousQuery | NamedQuery | FragmentDefinition
 *   AnonymousQuery     := SelectionSet
 *   NamedQuery         := "query" [Name] [VariableDefinitions] [Directives] SelectionSet
 *   FragmentDefinition := "fragment" Name "on" Name [Directives] SelectionSet
 *
 * Scanning rules:
 * - `# ...` comments, `"..."` strings, and `"""..."""` block strings are skipped
 *   without interpretation, so keywords inside them cannot smuggle intent;
 * - `(` / `[` open a value or argument group. Braces inside a group are object
 *   values, never selection sets, so they do not change definition state. This
 *   keeps `query Q($v: In = {k: 1}) { f }` and `query @dir(if: {a: 1}) { f }`
 *   correctly classified as single query definitions;
 * - a definition keyword found while not at a definition start is treated as
 *   scanner desync and rejected, which is what stops `query Foo mutation Bar { x }`
 *   from being accepted as a lone query;
 * - unterminated strings, unbalanced braces, unbalanced groups, and documents
 *   with no executable definition are rejected.
 *
 * Known conservative rejections: a fragment or type named with a definition
 * keyword (for example `fragment mutation on X { y }`) is refused even though
 * GraphQL permits it.
 */
export function assertQueryOnlyDocument(document: string): void {
  let index = 0;
  let braceDepth = 0;
  let groupDepth = 0;
  let atDefinitionStart = true;
  let definitions = 0;
  const length = document.length;

  while (index < length) {
    const char = document[index]!;

    if (char === "#") {
      while (index < length && document[index] !== "\n" && document[index] !== "\r") index += 1;
      continue;
    }
    if (char === '"') {
      index = skipString(document, index);
      continue;
    }
    if (char === "@") {
      // Consume the directive name with its `@`, so a directive such as
      // `@directive` is never mistaken for a type-system definition keyword.
      index += 1;
      while (index < length && isNameContinue(document[index]!)) index += 1;
      continue;
    }
    if (char === "(" || char === "[") {
      groupDepth += 1;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      groupDepth -= 1;
      if (groupDepth < 0) throw new Error("GraphQL document has unbalanced argument groups");
      index += 1;
      continue;
    }
    if (char === "{") {
      if (groupDepth === 0) {
        if (braceDepth === 0 && atDefinitionStart) {
          definitions += 1;
          atDefinitionStart = false;
        }
        braceDepth += 1;
      }
      index += 1;
      continue;
    }
    if (char === "}") {
      if (groupDepth === 0) {
        braceDepth -= 1;
        if (braceDepth < 0) throw new Error("GraphQL document has unbalanced braces");
        if (braceDepth === 0) atDefinitionStart = true;
      }
      index += 1;
      continue;
    }
    if (isNameStart(char)) {
      let end = index + 1;
      while (end < length && isNameContinue(document[end]!)) end += 1;
      const name = document.slice(index, end);
      if (braceDepth === 0 && groupDepth === 0) {
        if (atDefinitionStart) {
          if (name !== "query" && name !== "fragment") {
            throw new Error(`GraphQL document permits only query and fragment definitions, found ${name}`);
          }
          definitions += 1;
          atDefinitionStart = false;
        } else if (DEFINITION_KEYWORDS.has(name)) {
          throw new Error(`GraphQL document is ambiguous: unexpected ${name} definition keyword`);
        }
      }
      index = end;
      continue;
    }
    index += 1;
  }

  if (braceDepth !== 0) throw new Error("GraphQL document has unbalanced braces");
  if (groupDepth !== 0) throw new Error("GraphQL document has unbalanced argument groups");
  if (definitions === 0) throw new Error("GraphQL document contains no executable definition");
}

function skipString(document: string, start: number): number {
  const length = document.length;
  if (document.startsWith('"""', start)) {
    let index = start + 3;
    while (index < length) {
      if (document[index] === "\\" && document.startsWith('"""', index + 1)) {
        index += 4;
        continue;
      }
      if (document.startsWith('"""', index)) return index + 3;
      index += 1;
    }
    throw new Error("GraphQL document has an unterminated block string");
  }
  let index = start + 1;
  while (index < length) {
    const char = document[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    if (char === "\n" || char === "\r") break;
    index += 1;
  }
  throw new Error("GraphQL document has an unterminated string");
}

function isNameStart(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
}

function isNameContinue(char: string): boolean {
  return isNameStart(char) || (char >= "0" && char <= "9");
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const type = value.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/** Drop a trailing partial occurrence of `needle` left by a truncation cut. */
function stripTrailingPrefix(text: string, needle: string): string {
  const longest = Math.min(needle.length - 1, text.length);
  for (let length = longest; length > 0; length -= 1) {
    if (text.endsWith(needle.slice(0, length))) return text.slice(0, text.length - length);
  }
  return text;
}

/** Cut back to the last complete UTF-8 sequence so truncation cannot emit U+FFFD. */
function trimToUtf8Boundary(buffer: Buffer): Buffer {
  for (let back = 1; back <= 4 && back <= buffer.byteLength; back += 1) {
    const byte = buffer[buffer.byteLength - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return back < needed ? buffer.subarray(0, buffer.byteLength - back) : buffer;
  }
  return buffer;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const raw = Buffer.from(await response.text(), "utf8");
    if (raw.byteLength > maxBytes) {
      return { text: trimToUtf8Boundary(raw.subarray(0, maxBytes)).toString("utf8"), truncated: true };
    }
    return { text: raw.toString("utf8"), truncated: false };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    const chunk = Buffer.from(value);
    const remaining = maxBytes - retained;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        retained = maxBytes;
      }
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(chunk);
    retained += chunk.byteLength;
  }
  const joined = Buffer.concat(chunks);
  const bounded = truncated ? trimToUtf8Boundary(joined) : joined;
  return { text: bounded.toString("utf8"), truncated };
}
