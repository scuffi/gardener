import { McpServer, type AuthInfo, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { createMcpHandler, type McpAuthContext, type StatelessMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { authorizeMcpTool, type GardenerMcpTokenProps } from "./auth-context";
import { publicToolError, toolResult } from "./redaction";
import {
  assertSourceBundleSize,
  catalogInputSchema,
  diffInputSchema,
  explainInputSchema,
  getAgentInputSchema,
  getRunTraceInputSchema,
  listAgentsInputSchema,
  publishDraftInputSchema,
  simulateInputSchema,
  validateInputSchema,
} from "./schemas";
import { GARDENER_MCP_TOOL_SCOPES, type GardenerMcpScope } from "./scopes";
import type { ActiveGardenerMcpPrincipal, GardenerMcpAuthorizedServices, JsonObject } from "./services";

export const GARDENER_MCP_SERVER_INFO = { name: "gardener-authoring", version: "1.0.0" } as const;

const pausedDraftReceiptSchema = z.object({
  lifecycle: z.literal("paused_draft"),
  draftId: z.string().min(1).max(128),
  contentHash: z.string().min(16).max(128),
  updatedAt: z.string().datetime({ offset: true }),
  active: z.literal(false),
  enabled: z.literal(false),
  immutableRevisionCreated: z.literal(false),
}).strict();

function scopedTool<Input>(
  requiredScope: GardenerMcpScope,
  audience: string,
  services: GardenerMcpAuthorizedServices,
  operation: (input: Input, principal: ActiveGardenerMcpPrincipal) => Promise<unknown>,
): (input: Input, context: ServerContext) => Promise<CallToolResult> {
  return async (input, context) => {
    let principal: ActiveGardenerMcpPrincipal;
    try {
      const tokenPrincipal = authorizeMcpTool(context, requiredScope, audience);
      const active = await services.resolvePrincipal(tokenPrincipal);
      if (!active) throw new Error("MCP membership inactive");
      principal = active;
    } catch {
      return publicToolError("forbidden");
    }
    try {
      return toolResult(await operation(input, principal));
    } catch {
      return publicToolError("service_error");
    }
  };
}

export function createGardenerMcpServer(
  services: GardenerMcpAuthorizedServices,
  audience: string,
  onCreated?: (server: McpServer) => void,
): McpServer {
  if (!services.resolvePrincipal) throw new Error("MCP active-membership resolver is required");
  const server = new McpServer(GARDENER_MCP_SERVER_INFO);
  onCreated?.(server);

  server.registerTool("gardener.agent.list", {
    description: "List Gardener Agents visible to the authenticated owner.",
    inputSchema: listAgentsInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.list"], audience, services, (input, principal) => services.agents.list(input, principal)));

  server.registerTool("gardener.agent.get", {
    description: "Get one Agent or immutable Agent revision.",
    inputSchema: getAgentInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.get"], audience, services, (input, principal) => services.agents.get(input, principal)));

  server.registerTool("gardener.agent.catalog", {
    description: "Read the bounded trigger, capability, tool, model, and runtime catalog used for Agent validation.",
    inputSchema: catalogInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.catalog"], audience, services, (input, principal) => services.agents.catalog(input, principal)));

  server.registerTool("gardener.agent.validate", {
    description: "Parse and validate Agent source without storing or activating it.",
    inputSchema: validateInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.validate"], audience, services, async (input, principal) => {
    assertSourceBundleSize(input);
    return services.agents.validate(input, principal);
  }));

  server.registerTool("gardener.agent.explain", {
    description: "Explain resolved Agent semantics and requested capabilities without granting authority.",
    inputSchema: explainInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.explain"], audience, services, (input, principal) => services.agents.explain(input, principal)));

  server.registerTool("gardener.agent.diff", {
    description: "Compare two immutable Agent revisions, including source and capability changes.",
    inputSchema: diffInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.diff"], audience, services, (input, principal) => services.agents.diff(input, principal)));

  server.registerTool("gardener.agent.simulate", {
    description: "Run a bounded dry-run simulation. This tool cannot execute persistent effects.",
    inputSchema: simulateInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.simulate"], audience, services, async (input, principal) => {
    if (input.source) assertSourceBundleSize({ source: input.source });
    const result = await services.agents.simulate(input, principal);
    return { mode: "dry-run", executed: false, result } satisfies JsonObject;
  }));

  server.registerTool("gardener.agent.publish_draft", {
    description: "Create or update a paused mutable draft. It never creates a revision, activates, enables, approves, or executes.",
    inputSchema: publishDraftInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.agent.publish_draft"], audience, services, async (input, principal) => {
    assertSourceBundleSize(input);
    const receipt = await services.agents.savePausedDraft(input, principal);
    const parsed = pausedDraftReceiptSchema.safeParse(receipt);
    if (!parsed.success) throw new Error("Draft service violated paused-draft invariants");
    return parsed.data;
  }));

  server.registerTool("gardener.run.get_trace", {
    description: "Read a bounded product-redacted run trace.",
    inputSchema: getRunTraceInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, scopedTool(GARDENER_MCP_TOOL_SCOPES["gardener.run.get_trace"], audience, services, (input, principal) => services.runs.getTrace(input, principal)));

  return server;
}

export interface GardenerStatelessMcpOptions {
  route: string;
  audience: string;
  authProps: GardenerMcpTokenProps;
  authInfo: AuthInfo;
  onServerCreated?: (server: McpServer) => void;
}

export function createGardenerStatelessMcpHandler(
  services: GardenerMcpAuthorizedServices,
  options: GardenerStatelessMcpOptions,
): StatelessMcpHandler {
  if (!services.resolvePrincipal) throw new Error("MCP active-membership resolver is required");
  const authContext: McpAuthContext = { props: options.authProps };
  const handler = createMcpHandler(
    () => createGardenerMcpServer(services, options.audience, options.onServerCreated),
    {
      route: options.route,
      corsOptions: false,
      authContext,
      legacy: "stateless",
    },
  );
  const fetch: StatelessMcpHandler["fetch"] = (request, requestOptions) => handler.fetch(request, {
    ...requestOptions,
    authInfo: requestOptions?.authInfo ?? options.authInfo,
  });
  return Object.assign(
    (request: Request) => fetch(request),
    { fetch, notify: handler.notify },
  ) as StatelessMcpHandler;
}
