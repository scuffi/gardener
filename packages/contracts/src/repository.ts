import { z } from "zod";
import { githubNumericIdSchema } from "./identity";

const name = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/);

/**
 * Repository identity embedded in an exact operation. The numeric id is
 * authoritative; owner and name are display hints re-bound at apply time.
 */
export const operationRepositoryRefSchema = z.object({
  provider: z.literal("github"),
  id: githubNumericIdSchema,
  owner: name,
  name,
  defaultBranch: z.string().trim().min(1).max(255),
}).strict();
export type OperationRepositoryRef = z.infer<typeof operationRepositoryRefSchema>;
