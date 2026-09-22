import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultSourceRoot(cwd = process.cwd(), moduleUrl = import.meta.url): string {
  const packaged = resolve(dirname(fileURLToPath(moduleUrl)), "..", "assets");
  return existsSync(join(packaged, "gardener-distribution.json")) ? packaged : cwd;
}
