import { describe, expect, it } from "vitest";
import {
  assertQueryOnlyDocument,
  GitHubReadClient,
  type GitHubReadFetch,
} from "../src/github-read";

const TOKEN = "ghs_exampleRepositoryScopedToken";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function recorder(response: () => Response): { calls: Recorded[]; fetch: GitHubReadFetch } {
  const calls: Recorded[] = [];
  const fetch: GitHubReadFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) });
    return response();
  };
  return { calls, fetch };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers as Record<string, string> | undefined) },
    ...init,
  });
}

function client(fetch: GitHubReadFetch, limits?: Partial<ConstructorParameters<typeof GitHubReadClient>[0]["limits"]>): GitHubReadClient {
  return new GitHubReadClient({ token: TOKEN, fetch, ...(limits ? { limits } : {}) });
}

describe("GitHub read-only client construction", () => {
  it("requires a usable repository-scoped token", () => {
    const fetch: GitHubReadFetch = async () => jsonResponse({});
    expect(() => new GitHubReadClient({ token: "", fetch })).toThrow(/token is required/);
    expect(() => new GitHubReadClient({ token: "short", fetch })).toThrow(/token is required/);
    expect(() => new GitHubReadClient({ token: "has whitespace token", fetch })).toThrow(/token is required/);
    expect(() => new GitHubReadClient({ token: `ghs_valid\nInjected: header`, fetch })).toThrow(/token is required/);
  });

  it("never exposes the token as an own property", () => {
    const fetch: GitHubReadFetch = async () => jsonResponse({});
    const instance = client(fetch);
    expect(JSON.stringify(instance)).toBe("{}");
    expect(Object.values(instance as unknown as Record<string, unknown>)).toHaveLength(0);
    expect(Object.getOwnPropertyNames(instance)).toHaveLength(0);
  });
});

describe("REST reads", () => {
  it("sends bridge-controlled credentials and identity for a relative target", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ number: 7 }));
    const result = await client(fetch).rest({ path: "/repos/scuffi/gardener/issues/7" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/scuffi/gardener/issues/7");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers["user-agent"]).toBe("gardener-read-v1");
    expect(calls[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(result).toMatchObject({ transport: "rest", status: 200, ok: true, truncated: false });
    expect(result.json).toEqual({ number: 7 });
  });

  it("reads any resource the token can read, not only one repository", async () => {
    const { calls, fetch } = recorder(() => jsonResponse([{ login: "scuffi" }]));
    await client(fetch).rest({ path: "/user/orgs" });
    await client(fetch).rest({ path: "https://api.github.com/orgs/scuffi/teams?per_page=100" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/user/orgs",
      "https://api.github.com/orgs/scuffi/teams?per_page=100",
    ]);
  });

  it("supports HEAD without returning a body", async () => {
    const { calls, fetch } = recorder(() => new Response(null, { status: 304, headers: { etag: 'W/"abc"' } }));
    const result = await client(fetch).rest({ path: "/repos/scuffi/gardener", method: "HEAD" });
    expect(calls[0]!.method).toBe("HEAD");
    expect(result).toMatchObject({ status: 304, body: "", bodyBytes: 0, json: null });
    expect(result.headers.etag).toBe('W/"abc"');
  });

  it("rejects every mutating method", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({}));
    const instance = client(fetch);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get", "TRACE"]) {
      await expect(instance.rest({ path: "/repos/scuffi/gardener", method: method as "GET" }))
        .rejects.toThrow(/only GET and HEAD/);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects non-GitHub hosts, non-HTTPS schemes, credentials, and fragments", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({}));
    const instance = client(fetch);
    const cases: Array<[string, RegExp]> = [
      ["https://evil.example.com/repos", /api\.github\.com/],
      ["https://api.github.com.evil.example.com/x", /api\.github\.com/],
      ["https://api.github.com@evil.example.com/x", /api\.github\.com/],
      ["http://api.github.com/repos", /HTTPS/],
      ["ftp://api.github.com/repos", /HTTPS/],
      ["https://user:pass@api.github.com/repos", /credentials/],
      ["/repos/scuffi/gardener#fragment", /fragment/],
      ["//evil.example.com/repos", /protocol-relative/],
      ["repos/scuffi/gardener", /must start with/],
      ["/repos/../../admin", /relative segments/],
      ["/repos/scuffi/gardener\nX-Injected: 1", /whitespace/],
      ["/repos/scuffi/gardener 2", /whitespace/],
      ["/repos/scuffi/\u0007gardener", /control characters/],
      ["/repos/scuffi/\u007fgardener", /control characters/],
      ["/repos\\scuffi", /backslashes/],
    ];
    for (const [path, expected] of cases) {
      await expect(instance.rest({ path })).rejects.toThrow(expected);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses caller attempts to control credentials or identity headers", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({}));
    const instance = client(fetch);
    for (const name of ["authorization", "Authorization", "user-agent", "cookie", "x-github-api-version", "host"]) {
      await expect(instance.rest({ path: "/user", headers: { [name]: "attacker" } }))
        .rejects.toThrow(/not permitted/);
    }
    expect(calls).toHaveLength(0);

    await instance.rest({ path: "/user", headers: { Accept: "application/vnd.github.raw+json", "if-none-match": 'W/"x"' } });
    expect(calls[0]!.headers.accept).toBe("application/vnd.github.raw+json");
    expect(calls[0]!.headers["if-none-match"]).toBe('W/"x"');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers["user-agent"]).toBe("gardener-read-v1");
  });

  it("rejects header smuggling and oversized targets", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({}));
    const instance = client(fetch);
    await expect(instance.rest({ path: "/user", headers: { accept: "a\r\nauthorization: attacker" } }))
      .rejects.toThrow(/invalid value/);
    await expect(instance.rest({ path: `/repos/${"a".repeat(4_000)}` })).rejects.toThrow(/size limit/);
    await expect(instance.rest({ path: "/user", headers: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`accept${index}`, "x"])) }))
      .rejects.toThrow(/Too many/);
    expect(calls).toHaveLength(0);
  });

  it("returns only allowlisted response headers", async () => {
    const { fetch } = recorder(() => jsonResponse({ ok: true }, {
      headers: {
        etag: 'W/"tag"',
        link: '<https://api.github.com/x?page=2>; rel="next"',
        "x-ratelimit-remaining": "4999",
        "set-cookie": "session=secret",
        authorization: `Bearer ${TOKEN}`,
        "x-internal-debug": "leak",
      },
    }));
    const result = await client(fetch).rest({ path: "/repos/scuffi/gardener" });
    expect(Object.keys(result.headers).sort()).toEqual(["content-type", "etag", "link", "x-ratelimit-remaining"]);
    expect(JSON.stringify(result)).not.toContain("session=secret");
    expect(JSON.stringify(result)).not.toContain("leak");
  });

  it("redacts the token if it ever appears in a response", async () => {
    const { fetch } = recorder(() => jsonResponse({ echoed: `Bearer ${TOKEN}` }));
    const result = await client(fetch).rest({ path: "/user" });
    expect(result.body).not.toContain(TOKEN);
    expect(result.body).toContain("[redacted]");
    expect(JSON.stringify(result.json)).not.toContain(TOKEN);
  });

  it("leaves legitimate authorization content in JSON bodies byte-for-byte intact", async () => {
    // Real GitHub content routinely documents auth headers: README blobs, code
    // search hits, issue bodies, workflow files. Redaction must not corrupt it.
    const payload = {
      name: "README.md",
      content: "Send `authorization: Bearer <your-token>` with every request.",
      snippets: [
        "curl -H 'Authorization: Bearer ghp_example' https://api.github.com/user",
        "Authorization: token abc123",
        "authorization:Bearer squished",
      ],
      nested: { docs: { header: "AUTHORIZATION: Basic dXNlcjpwYXNz" } },
    };
    const { fetch } = recorder(() => jsonResponse(payload));
    const result = await client(fetch).rest({ path: "/repos/scuffi/gardener/contents/README.md" });

    expect(result.truncated).toBe(false);
    expect(result.body).toBe(JSON.stringify(payload));
    expect(result.json).toEqual(payload);
    expect(result.body).not.toContain("[redacted]");
  });

  it("keeps a body that mixes real credentials with authorization prose parseable", async () => {
    const payload = {
      guidance: "Authorization: Bearer <token> is required.",
      leaked: `Authorization: Bearer ${TOKEN}`,
    };
    const { fetch } = recorder(() => jsonResponse(payload));
    const result = await client(fetch).rest({ path: "/user" });

    expect(result.body).not.toContain(TOKEN);
    expect(result.json).toEqual({
      guidance: "Authorization: Bearer <token> is required.",
      leaked: "Authorization: Bearer [redacted]",
    });
    expect(JSON.parse(result.body)).toEqual(result.json);
  });

  it("preserves allowlisted response headers that mention authorization", async () => {
    const { fetch } = recorder(() => jsonResponse({ ok: true }, {
      headers: { link: '<https://api.github.com/x?authorization=required>; rel="next"' },
    }));
    const result = await client(fetch).rest({ path: "/user" });
    expect(result.headers.link).toBe('<https://api.github.com/x?authorization=required>; rel="next"');
  });

  it("bounds large responses and stops parsing truncated JSON", async () => {
    const payload = JSON.stringify({ blob: "x".repeat(5_000) });
    const { fetch } = recorder(() => jsonResponse(JSON.parse(payload)));
    const result = await client(fetch, { maxResponseBytes: 256 }).rest({ path: "/user" });
    expect(result.truncated).toBe(true);
    expect(result.bodyBytes).toBe(256);
    expect(result.bodyBytes).toBe(Buffer.byteLength(result.body, "utf8"));
    expect(result.json).toBeNull();
  });

  it("never emits a partial token when truncation splits one", async () => {
    const { fetch } = recorder(() => new Response(`xxxx${TOKEN}tail`, {
      headers: { "content-type": "application/json" },
    }));
    const result = await client(fetch, { maxResponseBytes: 14 }).rest({ path: "/user" });
    expect(result.truncated).toBe(true);
    expect(result.body).toBe("xxxx");
    expect(result.body).not.toContain("ghs_");
    expect(result.bodyBytes).toBe(4);
  });

  it("truncates on a UTF-8 boundary instead of emitting replacement characters", async () => {
    const { fetch } = recorder(() => new Response(`${"a".repeat(9)}\u00e9b`, {
      headers: { "content-type": "text/plain" },
    }));
    const result = await client(fetch, { maxResponseBytes: 10 }).rest({ path: "/user" });
    expect(result.truncated).toBe(true);
    expect(result.body).toBe("a".repeat(9));
    expect(result.body).not.toContain("\ufffd");
    expect(result.bodyBytes).toBe(9);
  });

  it("discards a body returned against a HEAD request", async () => {
    let cancelled = false;
    const { fetch } = recorder(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("unexpected"));
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "application/json" } }));
    const result = await client(fetch).rest({ path: "/user", method: "HEAD" });
    expect(result).toMatchObject({ body: "", bodyBytes: 0, json: null, truncated: false });
    expect(cancelled).toBe(true);
  });

  it("redacts transport failures instead of propagating credential-bearing text", async () => {
    const leaky: GitHubReadFetch = async () => {
      throw new Error(`connect ECONNREFUSED while sending authorization: Bearer ${TOKEN}`, {
        cause: { headers: { authorization: `Bearer ${TOKEN}` } },
      });
    };
    const instance = client(leaky);
    for (const attempt of [instance.rest({ path: "/user" }), instance.graphql({ query: "{ viewer { login } }" })]) {
      const error = await attempt.then(() => undefined, (value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      const serialized = `${(error as Error).message}${JSON.stringify((error as Error).cause ?? null)}`;
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).toContain("[redacted]");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("still scrubs authorization echoes from transport error text", async () => {
    // The credential-echo pattern is error-text only, and must survive even
    // when the echoed secret is not this client's exact token.
    const leaky: GitHubReadFetch = async () => {
      throw new Error("socket hang up sending Authorization: Bearer ghs_someOtherSecret");
    };
    const error = await client(leaky).rest({ path: "/user" })
      .then(() => undefined, (value: unknown) => value);
    expect((error as Error).message).not.toContain("ghs_someOtherSecret");
    expect((error as Error).message).toContain("authorization: [redacted]");
  });

  it("redacts failures raised while streaming the response body", async () => {
    const { fetch } = recorder(() => new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`stream reset with authorization: Bearer ${TOKEN}`);
      },
    }), { headers: { "content-type": "application/json" } }));
    const error = await client(fetch).rest({ path: "/user" }).then(() => undefined, (value: unknown) => value);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toContain("[redacted]");
  });

  it("applies a bounded per-request timeout and honours a caller abort signal", async () => {
    const pending: GitHubReadFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });

    const timedOut = await new GitHubReadClient({ token: TOKEN, fetch: pending, limits: { requestTimeoutMs: 5 } })
      .rest({ path: "/user" }).then(() => undefined, (value: unknown) => value);
    expect((timedOut as Error).message).toMatch(/timed out/);

    const controller = new AbortController();
    const cancelled = new GitHubReadClient({ token: TOKEN, fetch: pending, signal: controller.signal })
      .rest({ path: "/user" }).then(() => undefined, (value: unknown) => value);
    controller.abort();
    expect(((await cancelled) as Error).message).toMatch(/cancelled/);
  });

  it("always passes a composed abort signal to the transport", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({}));
    const signals: Array<AbortSignal | undefined> = [];
    const capturing: GitHubReadFetch = async (url, init) => {
      signals.push(init.signal);
      return fetch(url, init);
    };
    await client(capturing).rest({ path: "/user" });
    await client(capturing).graphql({ query: "{ viewer { login } }" });
    expect(calls).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
  });

  it("surfaces error statuses without throwing and keeps results JSON-safe", async () => {
    const { fetch } = recorder(() => jsonResponse({ message: "Not Found" }, { status: 404 }));
    const result = await client(fetch).rest({ path: "/repos/scuffi/missing" });
    expect(result).toMatchObject({ status: 404, ok: false });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("GraphQL reads", () => {
  it("posts query documents with bridge-controlled credentials", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: { viewer: { login: "scuffi" } } }));
    const result = await client(fetch).graphql({
      query: "query Viewer($n: Int) { viewer { login } }",
      variables: { n: 1 },
      operationName: "Viewer",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      query: "query Viewer($n: Int) { viewer { login } }",
      variables: { n: 1 },
      operationName: "Viewer",
    });
    expect(result.json).toEqual({ data: { viewer: { login: "scuffi" } } });
  });

  it("accepts anonymous queries, fragments, and introspection", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: {} }));
    const instance = client(fetch);
    await instance.graphql({ query: "{ viewer { login } }" });
    await instance.graphql({ query: "query { repository(owner: \"a\", name: \"b\") { id } }" });
    await instance.graphql({ query: "fragment F on Repository { id } query Q { repository(owner: \"a\", name: \"b\") { ...F } }" });
    await instance.graphql({ query: "{ __schema { types { name } } }" });
    expect(calls).toHaveLength(4);
  });

  it("rejects mutations, subscriptions, and type-system definitions", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: {} }));
    const instance = client(fetch);
    const rejected = [
      "mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }",
      "subscription { events { id } }",
      "query Ok { viewer { login } } mutation Evil { deleteRef(input: {refId: \"r\"}) { clientMutationId } }",
      "fragment F on X { id }\nmutation M { f }",
      "type Query { hi: String }",
      "schema { query: Query }",
      "extend type Query { hi: String }",
      "directive @evil on FIELD",
    ];
    for (const query of rejected) {
      await expect(instance.graphql({ query })).rejects.toThrow(/only query and fragment/);
    }
    expect(calls).toHaveLength(0);
  });

  it("cannot be fooled by comments, strings, or block strings", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: {} }));
    const instance = client(fetch);

    // Keywords that only appear inside ignored tokens must not change the verdict.
    await instance.graphql({ query: "# mutation { evil }\n{ viewer { login } }" });
    await instance.graphql({ query: '{ search(query: "mutation { evil }", type: ISSUE, first: 1) { codeCount } }' });
    await instance.graphql({ query: '{ search(query: """mutation { evil }""", type: ISSUE, first: 1) { codeCount } }' });
    expect(calls).toHaveLength(3);

    // A real mutation hidden after ignored tokens must still be rejected.
    await expect(instance.graphql({ query: '# harmless\n"""doc"""\nmutation Evil { f }' }))
      .rejects.toThrow(/only query and fragment/);
    await expect(instance.graphql({ query: '{ a(b: "}") { c } } mutation Evil { f }' }))
      .rejects.toThrow(/only query and fragment/);
    expect(calls).toHaveLength(3);
  });

  it("keeps definition state across argument groups, defaults, and directives", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: {} }));
    const instance = client(fetch);
    const accepted = [
      "query Q($v: In = {k: 1}) { f }",
      "query Q($v: In = {k: {nested: [1, 2]}}) { f }",
      "query Q @dir(if: {a: 1}) { f }",
      "query Q($v: [In!] = [{k: 1}, {k: 2}]) { f }",
      "{ a(filter: {b: {c: 1}}) { d } }",
      "query A($v: In = {k: 1}) { f } query B { g }",
    ];
    for (const query of accepted) await instance.graphql({ query });
    expect(calls).toHaveLength(accepted.length);
  });

  it("rejects scanner desync rather than trusting a partial parse", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: {} }));
    const instance = client(fetch);
    const desynced = [
      "query Foo mutation Bar { x }",
      "query Foo($v: In = {k: 1}) mutation Bar { x }",
      "fragment F subscription S { x }",
      "query Foo type Evil { x }",
    ];
    for (const query of desynced) {
      await expect(instance.graphql({ query })).rejects.toThrow(/ambiguous: unexpected/);
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed on malformed documents", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: {} }));
    const instance = client(fetch);
    await expect(instance.graphql({ query: "{ viewer { login }" })).rejects.toThrow(/unbalanced braces/);
    await expect(instance.graphql({ query: "{ a(b: 1 { c } }" })).rejects.toThrow(/unbalanced/);
    await expect(instance.graphql({ query: "{ a) { b } }" })).rejects.toThrow(/unbalanced argument groups/);
    await expect(instance.graphql({ query: "{ viewer } }" })).rejects.toThrow(/unbalanced braces/);
    await expect(instance.graphql({ query: '{ a(b: "unterminated) { c } }' })).rejects.toThrow(/unterminated string/);
    await expect(instance.graphql({ query: '{ a(b: """unterminated) { c } }' })).rejects.toThrow(/unterminated block string/);
    await expect(instance.graphql({ query: "# only a comment" })).rejects.toThrow(/no executable definition/);
    await expect(instance.graphql({ query: "   " })).rejects.toThrow(/no executable definition/);
    await expect(instance.graphql({ query: "" })).rejects.toThrow(/must not be empty/);
    expect(calls).toHaveLength(0);
  });

  it("bounds query and variable sizes and validates variable shape", async () => {
    const { calls, fetch } = recorder(() => jsonResponse({ data: {} }));
    const instance = client(fetch, { maxQueryBytes: 64, maxVariablesBytes: 32 });
    await expect(instance.graphql({ query: `{ viewer { ${"a".repeat(200)} } }` })).rejects.toThrow(/query exceeds/);
    await expect(instance.graphql({ query: "{ viewer { login } }", variables: { blob: "x".repeat(200) } }))
      .rejects.toThrow(/variables exceed/);
    await expect(instance.graphql({ query: "{ viewer { login } }", variables: [1, 2] as unknown as Record<string, unknown> }))
      .rejects.toThrow(/must be a JSON object/);
    await expect(instance.graphql({ query: "{ viewer { login } }", operationName: "not a name" }))
      .rejects.toThrow(/operationName/);
    expect(calls).toHaveLength(0);
  });

  it("redacts the token from GraphQL responses", async () => {
    const { fetch } = recorder(() => jsonResponse({ data: { note: TOKEN } }));
    const result = await client(fetch).graphql({ query: "{ viewer { login } }" });
    expect(result.body).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("query-only classifier", () => {
  it("accepts documents that are unambiguously read-only", () => {
    expect(() => assertQueryOnlyDocument("{ viewer { login } }")).not.toThrow();
    expect(() => assertQueryOnlyDocument("query A { a } query B { b }")).not.toThrow();
    expect(() => assertQueryOnlyDocument("query A($v: In = {k: 1}) { a }")).not.toThrow();
    expect(() => assertQueryOnlyDocument("query @directive { a }")).not.toThrow();
    expect(() => assertQueryOnlyDocument("query Q @type @input(if: true) { a }")).not.toThrow();
    expect(() => assertQueryOnlyDocument("{ a @include(if: true) { b } }")).not.toThrow();
  });

  it("rejects anything else", () => {
    expect(() => assertQueryOnlyDocument("mutation { a }")).toThrow();
    expect(() => assertQueryOnlyDocument("query A { a } subscription S { s }")).toThrow();
    expect(() => assertQueryOnlyDocument("QUERY A { a }")).toThrow();
    expect(() => assertQueryOnlyDocument("query Foo mutation Bar { x }")).toThrow(/ambiguous/);
  });

  it("documents its conservative rejections", () => {
    // Legal GraphQL, refused because the scanner cannot distinguish a fragment
    // named with a definition keyword from a second definition.
    expect(() => assertQueryOnlyDocument("fragment mutation on X { y }")).toThrow(/ambiguous/);
  });
});
