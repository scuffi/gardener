import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Flue must scan and contribute its Durable Objects before the Cloudflare
  // plugin resolves the Worker configuration.
  plugins: [
    ...flue({
      app: "src/task-runtime/actions-app.ts",
      agents: "**/task-runtime/flue-agent.ts",
      providers: ["cloudflare"],
      // Repository and model content must never be copied into Workers Traces.
      tracing: false,
    }),
    cloudflare({ config: flueWorkerConfig() }),
  ],
  build: {
    sourcemap: true,
    target: "es2022",
  },
});
