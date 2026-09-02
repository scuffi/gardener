import { describe, expect, it } from "vitest";
import { formatCost, formatTrigger, isEnabled, parseOperation, parseUsage, sentenceCase, tokenCount } from "./format";

describe("dashboard formatters", () => {
  it("normalizes D1 boolean flags", () => {
    expect(isEnabled(1)).toBe(true);
    expect(isEnabled(true)).toBe(true);
    expect(isEnabled(0)).toBe(false);
    expect(isEnabled(false)).toBe(false);
  });

  it("handles valid and malformed serialized data", () => {
    expect(parseUsage('{"inputTokens":120,"outputTokens":30}')).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(parseUsage("not-json")).toBeNull();
    expect(parseOperation('{"body":"Hello"}')).toEqual({ body: "Hello" });
    expect(parseOperation("plain text")).toEqual({ value: "plain text" });
  });

  it("formats usage and product labels consistently", () => {
    expect(tokenCount({ inputTokens: 120, outputTokens: 30 })).toBe(150);
    expect(formatCost(0.000123)).toBe("$0.000123");
    expect(formatCost(1.25)).toBe("$1.25");
    expect(sentenceCase("completed_with_errors")).toBe("Completed with errors");
    expect(sentenceCase("computerCodeChanges")).toBe("Computer code changes");
    expect(sentenceCase("deferred-preview")).toBe("Deferred preview");
    expect(formatTrigger("github.issue")).toBe("GitHub issue");
  });
});
