export function parse(args: string[]): {
  positional: string[];
  flags: Map<string, string | true>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const boolean = new Set(["yes", "personal", "verbose", "qualification", "execute", "dry-run", "demos"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!name || flags.has(name)) throw new Error(`Invalid or duplicate option: ${value}`);
    if (boolean.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
    flags.set(name, next);
    index += 1;
  }
  return { positional, flags };
}
