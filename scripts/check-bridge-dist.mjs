import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const artifacts = [
  "bridges/github/plan/dist/index.cjs",
  "bridges/github/apply/dist/index.cjs",
];

// Rebuild from the typed source before comparing. Merely checking whether dist
// was already dirty lets a stale committed bundle pass when source changed in
// an earlier commit; rebuilding makes source↔artifact drift observable even
// when this guard is run on its own rather than through the root build.
execFileSync("pnpm", ["--filter", "@gardener/runner", "build"], { stdio: "inherit" });
for (const artifact of artifacts) {
  if (!existsSync(artifact)) throw new Error(`Missing GitHub bridge artifact: ${artifact}`);
  execFileSync("git", ["ls-files", "--error-unmatch", artifact], { stdio: "ignore" });
}
execFileSync("git", ["diff", "--exit-code", "--", ...artifacts], { stdio: "inherit" });
