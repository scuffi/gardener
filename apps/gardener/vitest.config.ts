import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "ui/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: { reporter: ["text", "json", "html"] },
  },
});
