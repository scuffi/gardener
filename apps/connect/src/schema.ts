import {
  operationSchema,
  repositorySchema,
  type Operation,
} from "@gardener/contracts";
import { z } from "zod";

export { operationSchema, repositorySchema };
export type { Operation };

export const grantRequestSchema = z.object({
  instanceId: z.string().min(1),
  runId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(255),
  repository: repositorySchema,
  operations: z.array(operationSchema).min(1).max(20),
}).strict();

export const callbackUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
}, "callback URL must use HTTPS");

export function parseRepositoryFullName(value: string): { owner: string; name: string } | null {
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}
