export { operationSchema, repositoryEventV2Schema } from "@gardener/contracts";
export type { Operation, RepositoryEventV2 } from "@gardener/contracts";

export function parseRepositoryFullName(value: string): { owner: string; name: string } | null {
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}
