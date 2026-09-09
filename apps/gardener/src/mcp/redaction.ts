import type { CallToolResult } from "@modelcontextprotocol/server";

const sensitiveKey = /(?:authorization|cookie|credential|secret|token|private[_-]?key|client[_-]?secret|instance[_-]?token|access[_-]?token|refresh[_-]?token|password|session|oauth|grant|headers?|raw[_-]?(?:prompt|input|output|body))/i;
const credentialValue = /(?:Bearer\s+[A-Za-z0-9._~+/=-]+|gdn_[A-Za-z0-9_.-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STRING = 8_192;
const MAX_ARRAY = 100;
const MAX_KEYS = 100;
const MAX_DEPTH = 8;

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (credentialValue.test(value)) return "[redacted]";
    return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…[truncated]`;
  }
  if (typeof value !== "object") return String(value).slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH) return "[depth-limited]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) result.push(`[${value.length - MAX_ARRAY} items omitted]`);
    return result;
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries.slice(0, MAX_KEYS)) {
    result[key.slice(0, 128)] = sensitiveKey.test(key) ? "[redacted]" : redact(item, depth + 1, seen);
  }
  if (entries.length > MAX_KEYS) result._omitted = entries.length - MAX_KEYS;
  return result;
}

function boundedEnvelopePreview(value: string): string {
  const encoder = new TextEncoder();
  const serializedBytes = (end: number): number => encoder.encode(JSON.stringify({
    truncated: true,
    preview: value.slice(0, end),
  })).byteLength;

  // Bound the final JSON envelope rather than only the raw prefix: quotes and
  // backslashes in the serialized source are escaped again inside `preview`.
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(middle) <= MAX_OUTPUT_BYTES) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  while (end > 0 && serializedBytes(end) > MAX_OUTPUT_BYTES) end -= 1;
  return value.slice(0, end);
}

export function redactAndBoundOutput(value: unknown): Record<string, unknown> {
  const redacted = redact(value, 0, new WeakSet<object>());
  const object = redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : { result: redacted };
  const serialized = JSON.stringify(object);
  if (new TextEncoder().encode(serialized).byteLength <= MAX_OUTPUT_BYTES) return object;

  return {
    truncated: true,
    preview: boundedEnvelopePreview(serialized),
  };
}

export function toolResult(value: unknown): CallToolResult {
  const safe = redactAndBoundOutput(value);
  return {
    content: [{ type: "text", text: JSON.stringify(safe) }],
    structuredContent: safe,
  };
}

export function publicToolError(code: "forbidden" | "invalid_result" | "service_error"): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code }) }],
    structuredContent: { error: code },
  };
}
