import { createGitClient, type GitCliInput, type GitClient, type GitClientFactory } from "@cloudflare/computer/git";

const LOCAL_ONLY_COMMANDS = new Set([
  "add",
  "branch",
  "cat-file",
  "checkout",
  "clean",
  "commit",
  "diff",
  "hash-object",
  "init",
  "log",
  "ls-files",
  "ls-tree",
  "merge",
  "reset",
  "rev-parse",
  "rm",
  "show",
  "stash",
  "status",
  "tag",
  "update-ref",
]);

const NETWORK_METHODS = new Set(["clone", "fetch", "pull", "push", "remoteAdd", "remoteRemove", "remoteList"]);

export class LocalOnlyGitError extends Error {
  readonly code = "GARDENER_GIT_LOCAL_ONLY";

  constructor(operation: string) {
    super(`Git operation ${operation} is disabled: Gardener workspaces are local-only`);
    this.name = "LocalOnlyGitError";
  }
}

export function localGitSubcommand(argv: readonly string[]): string {
  const command = argv[0];
  // The caller supplies cwd separately. Reject global option forms rather than
  // attempting to interpret -C, -c, --git-dir, aliases, or config injection.
  if (!command || command.startsWith("-")) throw new LocalOnlyGitError("ambiguous-global-options");
  return command.toLowerCase();
}

export function assertLocalOnlyGitCli(input: GitCliInput | { argv: string[] }): void {
  const command = localGitSubcommand(input.argv);
  if (!LOCAL_ONLY_COMMANDS.has(command)) {
    throw new LocalOnlyGitError(command);
  }
}

/**
 * Wraps Computer's typed isomorphic-git client. The Worker shell's built-in
 * `git` command calls this same proxy, so clone/fetch/pull/push/ls-remote and
 * unknown CLI subcommands fail before isomorphic-git can perform I/O.
 */
export function createLocalOnlyGitClientFactory(baseFactory: GitClientFactory = createGitClient()): GitClientFactory {
  return (options) => {
    const client = baseFactory(options);
    return new Proxy(client, {
      get(target, property, receiver) {
        if (typeof property === "string" && NETWORK_METHODS.has(property)) {
          return async () => {
            throw new LocalOnlyGitError(property);
          };
        }
        if (property === "cli") {
          return async (input: GitCliInput) => {
            assertLocalOnlyGitCli(input);
            return target.cli(input);
          };
        }
        if (property === "configSet") {
          return async (input: { path: string; value: string | boolean | number | undefined }) => {
            if (/^(?:credential|http|https|remote|url)\./i.test(input.path)) {
              throw new LocalOnlyGitError(`config:${input.path}`);
            }
            return target.configSet(input);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as GitClient;
  };
}
