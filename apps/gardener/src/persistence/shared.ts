export type JsonObject = Record<string, unknown>;
export type PolicyMode = "disabled" | "approval" | "automatic";

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T = unknown>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

export function changed(result: unknown): boolean {
  const value = result as { meta?: { changes?: number } };
  return Number(value.meta?.changes ?? 0) > 0;
}

export function bool(value: number): boolean {
  return value === 1;
}

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: number;
  revision_counter: number;
  active_revision_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AgentDto {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  revisionCounter: number;
  activeRevisionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function agentDto(row: AgentRow): AgentDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    enabled: bool(row.enabled),
    revisionCounter: row.revision_counter,
    activeRevisionId: row.active_revision_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
