import { z } from "zod";

/** Numeric GitHub identifier. Logins and names are mutable; ids are authoritative. */
export const githubNumericIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/, "expected a numeric GitHub id");
