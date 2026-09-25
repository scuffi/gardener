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

/**
 * The directory `list_files` should list: `.` for the root, else a validated
 * relative path. One leading `./` and one trailing `/` are dropped first, since
 * models write `./src` and `src/` for `src`; the strict check then runs on what
 * remains, so `..`, absolute paths and empty segments are still refused.
 */
export function listFilesPath(value: unknown): string {
  if (ROOT_ALIASES.includes(value)) return ".";
  if (typeof value !== "string") return repositoryPath(value);
  let path = value.startsWith("./") ? value.slice(2) : value;
  if (path.endsWith("/")) path = path.slice(0, -1);
  return repositoryPath(path);
}
