/**
 * Enforces the dashboard UI conventions documented in `apps/gardener/ui/AGENTS.md`
 * and `docs/design-system.md`.
 *
 * These rules exist because the pre-redesign UI drifted into a 678-line bespoke stylesheet with
 * 1,622-character source lines. Checking them in CI keeps the contract real instead of aspirational.
 *
 * A line may opt out of the colour rule with a `design-system-exempt: <reason>` comment on that
 * line or within the few lines above it, so the marker can sit above a multi-line statement.
 * Exemptions are reported on every run so they stay visible rather than accumulating silently.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const UI_ROOT = new URL("../apps/gardener/ui/", import.meta.url);
const MAX_LINE = 120;
const MAX_CSS_LINES = 100;

const failures = [];
const exemptions = [];
const fail = (file, line, message) =>
  failures.push(`${file}${line ? `:${line}` : ""}  ${message}`);

async function sourceFiles(directory = UI_ROOT, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(new URL(`${entry.name}/`, directory), relativePath)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      found.push(relativePath);
    }
  }
  return found;
}

/** Remove comment bodies so documentation prose is never mistaken for product code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const RAW_COLOUR =
  /#[0-9a-fA-F]{3,8}\b|\b(?:bg|text|border|ring|from|via|to|fill|stroke|shadow|outline|decoration|accent|caret|divide)-(?:red|blue|green|neutral|gray|grey|slate|zinc|stone|orange|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const DARK_VARIANT = /(?:^|[\s"'`{(])dark:[a-z[]/;
const INLINE_QUERY_KEY = /queryKey:\s*\[\s*["'`]/;
const KUMO_IMPORT = /from\s+["']@cloudflare\/kumo/;
/** How far above a line the `design-system-exempt` marker may sit (multi-line statements). */
const EXEMPT_LOOKBACK = 4;

const files = await sourceFiles();

for (const file of files) {
  const raw = await readFile(new URL(file, UI_ROOT), "utf8");
  const rawLines = raw.split("\n");
  const codeLines = stripComments(raw).split("\n");

  rawLines.forEach((line, index) => {
    if (line.length > MAX_LINE) {
      fail(file, index + 1, `line is ${line.length} chars (max ${MAX_LINE})`);
    }
  });

  // Kumo may only be imported inside primitives/, which is the single audited surface.
  if (!file.startsWith("primitives/")) {
    codeLines.forEach((line, index) => {
      if (KUMO_IMPORT.test(line)) {
        fail(file, index + 1, "imports @cloudflare/kumo directly; import from primitives instead");
      }
    });
  }

  codeLines.forEach((line, index) => {
    const exemptHere = rawLines
      .slice(Math.max(0, index - EXEMPT_LOOKBACK), index + 1)
      .some((candidate) => /design-system-exempt/.test(candidate));

    if (RAW_COLOUR.test(line) || DARK_VARIANT.test(line)) {
      if (exemptHere) {
        exemptions.push(`${file}:${index + 1}  ${line.trim().slice(0, 80)}`);
      } else {
        fail(file, index + 1, "raw colour or dark: variant; use Kumo semantic tokens");
      }
    }

    if (file !== "lib/query-keys.ts" && INLINE_QUERY_KEY.test(line)) {
      fail(file, index + 1, "inline queryKey; use lib/query-keys.ts");
    }
  });
}

// styles.css must remain globals-only.
const css = await readFile(new URL("styles.css", UI_ROOT), "utf8");
const cssLineCount = css.split("\n").length;
// The reduced-motion block legitimately needs `!important` to defeat component-level animation,
// so it is excluded before the `!important` check.
const cssCode = css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/@media\s*\(prefers-reduced-motion[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

if (cssLineCount > MAX_CSS_LINES) {
  fail("styles.css", null, `${cssLineCount} lines (max ${MAX_CSS_LINES}); move styling into components`);
}
for (const [pattern, message] of [
  [/#[0-9a-fA-F]{3,8}\b/, "hardcoded colour; use a Kumo token"],
  [/--gd-[a-z-]+/, "re-aliased design token; reference Kumo tokens directly"],
  [/data-mode=/, "scheme override; Kumo owns [data-mode] and redefines every token"],
  [/!important/, "!important; stop fighting Kumo"],
]) {
  if (pattern.test(cssCode)) fail("styles.css", null, message);
}

console.log(`Checked ${files.length} UI source files and styles.css (${cssLineCount} lines).`);

if (exemptions.length) {
  console.log(`\n${exemptions.length} documented colour exemption(s):`);
  for (const entry of exemptions) console.log(`  ${entry}`);
}

if (failures.length) {
  console.error(`\n${failures.length} UI convention failure(s):`);
  for (const entry of failures) console.error(`  ${entry}`);
  console.error("\nSee apps/gardener/ui/AGENTS.md and docs/design-system.md.");
  process.exitCode = 1;
} else {
  console.log("\nAll UI conventions pass.");
}
