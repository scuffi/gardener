import type { JsonValue } from "./types";

const SCHEMA_KEYS = new Set([
  "type", "const", "enum", "properties", "required", "additionalProperties", "items",
  "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum",
]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 256;

export function supportedResultSchemaIssue(value: unknown): string | null {
  return schemaIssue(value, "resultDataSchema", 0);
}

export function resultDataSchemaIssue(schema: { [key: string]: JsonValue }, value: unknown): string | null {
  return dataIssue(schema, value, "result.data", 0);
}

function schemaIssue(value: unknown, label: string, depth: number): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  if (depth > MAX_SCHEMA_DEPTH) return `${label} exceeds the supported schema depth`;
  const unknown = Object.keys(value).filter((key) => !SCHEMA_KEYS.has(key));
  if (unknown.length) return `${label} contains unsupported JSON Schema keywords: ${unknown.join(", ")}`;
  if (value.type === undefined && value.const === undefined && value.enum === undefined) {
    return `${label} must declare type, const, or enum`;
  }
  if ("type" in value && (typeof value.type !== "string" || !TYPES.has(value.type))) {
    return `${label}.type is unsupported`;
  }
  if ("const" in value && !isJsonValue(value.const)) return `${label}.const must be JSON`;
  if ("enum" in value) {
    if (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > 100 || value.enum.some((item) => !isJsonValue(item))) {
      return `${label}.enum must contain 1-100 JSON values`;
    }
  }

  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) {
      return `${label}.${key} must be a non-negative safe integer`;
    }
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      return `${label}.${key} must be a finite number`;
    }
  }
  if (typeof value.minLength === "number" && typeof value.maxLength === "number" && value.minLength > value.maxLength) {
    return `${label}.minLength cannot exceed maxLength`;
  }
  if (typeof value.minItems === "number" && typeof value.maxItems === "number" && value.minItems > value.maxItems) {
    return `${label}.minItems cannot exceed maxItems`;
  }
  if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum) {
    return `${label}.minimum cannot exceed maximum`;
  }

  if (value.properties !== undefined) {
    if (value.type !== "object" || !isRecord(value.properties)) return `${label}.properties requires object type`;
    const entries = Object.entries(value.properties);
    if (entries.length > MAX_SCHEMA_PROPERTIES) return `${label}.properties exceeds ${MAX_SCHEMA_PROPERTIES} entries`;
    for (const [key, child] of entries) {
      const issue = schemaIssue(child, `${label}.properties.${key}`, depth + 1);
      if (issue) return issue;
    }
  }
  if (value.required !== undefined) {
    if (value.type !== "object" || !Array.isArray(value.required) || value.required.some((item) => typeof item !== "string")) {
      return `${label}.required requires an array of property names on an object schema`;
    }
    const required = value.required as string[];
    if (new Set(required).size !== required.length) return `${label}.required contains duplicates`;
    const properties = isRecord(value.properties) ? value.properties : {};
    if (required.some((key) => !(key in properties))) return `${label}.required references an undeclared property`;
  }
  if (value.additionalProperties !== undefined && (value.type !== "object" || typeof value.additionalProperties !== "boolean")) {
    return `${label}.additionalProperties must be boolean on an object schema`;
  }
  if (value.items !== undefined) {
    if (value.type !== "array") return `${label}.items requires array type`;
    const issue = schemaIssue(value.items, `${label}.items`, depth + 1);
    if (issue) return issue;
  }
  if ((value.minLength !== undefined || value.maxLength !== undefined) && value.type !== "string") {
    return `${label} string length constraints require string type`;
  }
  if ((value.minItems !== undefined || value.maxItems !== undefined) && value.type !== "array") {
    return `${label} item constraints require array type`;
  }
  if ((value.minimum !== undefined || value.maximum !== undefined) && value.type !== "number" && value.type !== "integer") {
    return `${label} numeric constraints require number or integer type`;
  }
  return null;
}

function dataIssue(schema: Record<string, unknown>, value: unknown, label: string, depth: number): string | null {
  if (depth > MAX_SCHEMA_DEPTH) return `${label} exceeds the supported schema depth`;
  if ("const" in schema && !jsonEqual(value, schema.const)) return `${label} does not match const`;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(value, candidate))) return `${label} is not in enum`;

  switch (schema.type) {
    case "null": if (value !== null) return `${label} must be null`; break;
    case "boolean": if (typeof value !== "boolean") return `${label} must be boolean`; break;
    case "string": {
      if (typeof value !== "string") return `${label} must be string`;
      if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${label} is shorter than minLength`;
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${label} exceeds maxLength`;
      break;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        return `${label} must be ${schema.type}`;
      }
      if (typeof schema.minimum === "number" && value < schema.minimum) return `${label} is below minimum`;
      if (typeof schema.maximum === "number" && value > schema.maximum) return `${label} exceeds maximum`;
      break;
    }
    case "array": {
      if (!Array.isArray(value)) return `${label} must be array`;
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${label} has fewer than minItems`;
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${label} exceeds maxItems`;
      if (isRecord(schema.items)) for (let index = 0; index < value.length; index += 1) {
        const issue = dataIssue(schema.items, value[index], `${label}[${index}]`, depth + 1);
        if (issue) return issue;
      }
      break;
    }
    case "object": {
      if (!isRecord(value)) return `${label} must be object`;
      const properties = isRecord(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) return `${label}.${key} is required`;
      }
      if (schema.additionalProperties === false) {
        const unknown = Object.keys(value).filter((key) => !(key in properties));
        if (unknown.length) return `${label} contains undeclared properties: ${unknown.join(", ")}`;
      }
      for (const [key, child] of Object.entries(properties)) if (key in value && isRecord(child)) {
        const issue = dataIssue(child, value[key], `${label}.${key}`, depth + 1);
        if (issue) return issue;
      }
      break;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 20_000 || current.depth > 32) return false;
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (typeof current.value !== "object") return false;
    if (seen.has(current.value)) return false;
    seen.add(current.value);
    const values = Array.isArray(current.value) ? current.value : Object.values(current.value as Record<string, unknown>);
    for (const child of values) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
}
