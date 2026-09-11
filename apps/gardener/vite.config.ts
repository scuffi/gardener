import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const fluePlugins = flue({
  app: "src/app.ts",
  agents: "harness/flue/generic-agent.ts",
  providers: ["cloudflare"],
  // Repository and model content must never be copied into Workers Traces.
  tracing: false,
}).map((plugin): Plugin => ({
  ...plugin,
  // Gardener also has a React client environment. Flue's source transforms
  // belong only to the Worker environment and must not parse client TSX.
  applyToEnvironment(environment) {
    return environment.name === "gardener";
  },
}));

export default defineConfig({
  // Flue must scan and contribute its one generic Durable Object before the
  // Cloudflare plugin resolves the Worker configuration.
  plugins: [...fluePlugins, react(), tailwindcss(), cloudflare({ config: flueWorkerConfig() })],
  build: {
    sourcemap: true,
    target: "es2022",
  },
});
