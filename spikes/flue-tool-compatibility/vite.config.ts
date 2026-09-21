import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    ...flue({
      app: "app.ts",
      agents: "agent.ts",
      providers: ["cloudflare"],
      tracing: false,
    }),
    cloudflare({ config: flueWorkerConfig() }),
  ],
  build: { sourcemap: true, target: "es2022" },
});
