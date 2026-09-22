import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const artifacts = [
  "bridges/github/plan/dist/index.cjs",
  "bridges/github/apply/dist/index.cjs",
];
for (const artifact of artifacts) {
  if (!existsSync(artifact)) throw new Error(`Missing GitHub bridge artifact: ${artifact}`);
  execFileSync("git", ["ls-files", "--error-unmatch", artifact], { stdio: "ignore" });
}
execFileSync("git", ["diff", "--exit-code", "--", ...artifacts], { stdio: "inherit" });
