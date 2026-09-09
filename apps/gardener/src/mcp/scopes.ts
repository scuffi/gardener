export const GARDENER_MCP_SCOPES = [
  "gardener:agents:read",
  "gardener:agents:validate",
  "gardener:agents:simulate",
  "gardener:agents:drafts:write",
  "gardener:runs:read",
] as const;

export type GardenerMcpScope = (typeof GARDENER_MCP_SCOPES)[number];

const scopeSet = new Set<string>(GARDENER_MCP_SCOPES);

export function isGardenerMcpScope(value: string): value is GardenerMcpScope {
  return scopeSet.has(value);
}

export function validateGardenerMcpScopes(scopes: readonly string[]): GardenerMcpScope[] {
  const unique: GardenerMcpScope[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!isGardenerMcpScope(scope)) throw new Error("Unknown Gardener MCP scope");
    if (!seen.has(scope)) {
      seen.add(scope);
      unique.push(scope);
    }
  }
  return unique;
}

export const GARDENER_MCP_TOOL_SCOPES = {
  "gardener.agent.list": "gardener:agents:read",
  "gardener.agent.get": "gardener:agents:read",
  "gardener.agent.catalog": "gardener:agents:read",
  "gardener.agent.validate": "gardener:agents:validate",
  "gardener.agent.explain": "gardener:agents:read",
  "gardener.agent.diff": "gardener:agents:read",
  "gardener.agent.simulate": "gardener:agents:simulate",
  "gardener.agent.publish_draft": "gardener:agents:drafts:write",
  "gardener.run.get_trace": "gardener:runs:read",
} as const satisfies Record<string, GardenerMcpScope>;

export type GardenerMcpToolName = keyof typeof GARDENER_MCP_TOOL_SCOPES;

export const GARDENER_MCP_SCOPE_LABELS: Record<GardenerMcpScope, string> = {
  "gardener:agents:read": "Read agent definitions and catalogs",
  "gardener:agents:validate": "Validate agent source",
  "gardener:agents:simulate": "Run non-mutating agent simulations",
  "gardener:agents:drafts:write": "Create or update paused drafts",
  "gardener:runs:read": "Read redacted run traces",
};
