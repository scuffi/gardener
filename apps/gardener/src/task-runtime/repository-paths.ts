/**
 * Validates a repository-relative path from a tool call. Absolute paths,
 * backslashes, and empty, `.` or `..` segments are refused, so a path can
 * never leave the checked-out workspace.
 */
export function repositoryPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\\") || value.startsWith("/")) {
    throw new Error("Invalid repository path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Repository path escapes the workspace");
  return value;
}

/**
 * Spellings models commonly use for "the repository root". Only `list_files`
 * accepts them, and only as the root itself; every other path stays strict.
 */
const ROOT_ALIASES: readonly unknown[] = [undefined, ".", "", "/", "./"];

/** The directory `list_files` should list: `.` for the root, else a validated relative path. */
export function listFilesPath(value: unknown): string {
  return ROOT_ALIASES.includes(value) ? "." : repositoryPath(value);
}
