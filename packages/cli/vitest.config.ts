import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{
    // Matches esbuild's `--loader:.md=text` in the build script.
    name: "markdown-as-text",
    enforce: "pre",
    transform(code, id) {
      return id.endsWith(".md") ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined;
    },
  }],
});
