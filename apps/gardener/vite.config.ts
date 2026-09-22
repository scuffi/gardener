import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const fluePlugins = flue({
  app: "src/task-runtime/actions-app.ts",
  agents: "**/task-runtime/flue-agent.ts",
  providers: ["cloudflare"],
  // Repository and model content must never be copied into Workers Traces.
  tracing: false,
}).map((plugin): Plugin => ({
  ...plugin,
  // Gardener also has a React client environment. Flue's source transforms
  // belong only to the Worker environment and must not parse client TSX.
  applyToEnvironment(environment) {
    return environment.name === "gardener_actions_v1_runtime";
  },
}));

export default defineConfig({
  // Flue must scan and contribute its generic Durable Objects before the
  // Cloudflare plugin resolves the Worker configuration.
  plugins: [...fluePlugins, react(), tailwindcss(), cloudflare({ config: flueWorkerConfig() })],
  build: {
    sourcemap: true,
    target: "es2022",
  },
});
