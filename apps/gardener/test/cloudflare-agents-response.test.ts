import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

import { parseDirectResponse } from "../src/harness/cloudflare-agents/generic-agent";

describe("Cloudflare Agents Workers AI response normalization", () => {
  it("accepts both documented Workers AI text response variants", () => {
    expect(parseDirectResponse('{"status":"completed"}')).toEqual({ response: '{"status":"completed"}' });
    expect(parseDirectResponse({ response: '{"status":"completed"}', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
      .toEqual({ response: '{"status":"completed"}', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  });

  it("rejects streams, async request handles, and malformed usage", () => {
    expect(parseDirectResponse(new ReadableStream())).toBeNull();
    expect(parseDirectResponse({ request_id: "async-request" })).toBeNull();
    expect(parseDirectResponse({ response: "ok", usage: "invalid" })).toBeNull();
  });
});
