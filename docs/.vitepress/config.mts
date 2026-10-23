import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

const repository = "https://github.com/scuffi/gardener";
const site = "https://gardener.scuffi.dev";

// Served as static assets by a Cloudflare Worker (docs/wrangler.jsonc), deployed by
// .github/workflows/docs.yml.
export default defineConfig({
  title: "Gardener",
  description: "AI maintenance tasks for your GitHub repositories, run from GitHub Actions.",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: site },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/gardener.svg" }],
    ["meta", { name: "theme-color", content: "#2f9e5f" }],
  ],
  // The docs are also read on GitHub, so they stay plain Markdown; this file only adds navigation.
  themeConfig: {
    logo: "/gardener.svg",
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Reference", link: "/task-reference" },
      { text: "llms.txt", link: "/llms.txt", target: "_blank" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "Onboarding a repository", link: "/onboarding" },
          { text: "Creating tasks", link: "/task-authoring" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Task reference", link: "/task-reference" },
          { text: "CLI reference", link: "/cli" },
        ],
      },
      {
        text: "Running Gardener",
        items: [
          { text: "Operations", link: "/operations" },
          { text: "Architecture", link: "/architecture" },
          { text: "Dependency policy", link: "/version-policy" },
        ],
      },
    ],
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repository }],
    editLink: {
      pattern: `${repository}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
  },
  vite: {
    // Emits llms.txt (an index), llms-full.txt (every page in one file) and a raw .md copy of
    // each page, so agents can read the docs without parsing HTML.
    plugins: [
      llmstxt({
        domain: site,
        ignoreFiles: ["index.md"],
        description: "AI maintenance tasks for your GitHub repositories, run from GitHub Actions.",
      }),
    ],
  },
});
