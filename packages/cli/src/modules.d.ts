/** Markdown imported as text: esbuild's `text` loader, and the plugin in vitest.config.ts. */
declare module "*.md" {
  const text: string;
  export default text;
}
