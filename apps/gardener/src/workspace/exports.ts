// Keep preview-package runtime exports isolated from Gardener's public adapter.
// Wrangler must export these entrypoints for Computer's Dynamic Worker and
// container egress plumbing; agents must never receive them as tools.
export { WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";
