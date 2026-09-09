import type { AuthInfo, ServerContext } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { GARDENER_MCP_SCOPES, type GardenerMcpScope, validateGardenerMcpScopes } from "./scopes";
import type { GardenerMcpPrincipal } from "./services";

export const gardenerMcpTokenPropsSchema = z.object({
  kind: z.literal("gardener.mcp-token/v1"),
  githubUserId: z.string().min(1).max(128),
  githubLogin: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  clientId: z.string().min(1).max(512),
  audience: z.string().url().max(2_048),
  scopes: z.array(z.enum(GARDENER_MCP_SCOPES)).max(GARDENER_MCP_SCOPES.length),
  authorizationId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export type GardenerMcpTokenProps = z.infer<typeof gardenerMcpTokenPropsSchema>;

export function bearerFromRequest(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match?.[1] || match[1].length > 20_000) throw new Error("Invalid bearer credential");
  return match[1];
}

export function createMcpAuthInfo(
  request: Request,
  propsInput: unknown,
  expectedAudience: string,
): { authInfo: AuthInfo; props: GardenerMcpTokenProps } {
  const props = gardenerMcpTokenPropsSchema.parse(propsInput);
  if (props.audience !== expectedAudience) throw new Error("Invalid MCP audience");
  const scopes = validateGardenerMcpScopes(props.scopes);
  return {
    props: { ...props, scopes },
    authInfo: {
      token: bearerFromRequest(request),
      clientId: props.clientId,
      scopes,
      resource: new URL(expectedAudience),
      extra: { gardener: props },
    },
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function authorizeMcpTool(
  context: ServerContext,
  requiredScope: GardenerMcpScope,
  expectedAudience: string,
): GardenerMcpPrincipal {
  const authInfo = context.http?.authInfo;
  const workerProps = getMcpAuthContext()?.props;
  if (!authInfo || !workerProps) throw new Error("MCP authorization context is missing");

  const props = gardenerMcpTokenPropsSchema.parse(workerProps);
  const extraProps = gardenerMcpTokenPropsSchema.parse(authInfo.extra?.gardener);
  const authScopes = validateGardenerMcpScopes(authInfo.scopes);

  if (
    props.audience !== expectedAudience ||
    authInfo.resource?.toString() !== expectedAudience ||
    props.clientId !== authInfo.clientId ||
    props.clientId !== extraProps.clientId ||
    props.githubUserId !== extraProps.githubUserId ||
    props.githubLogin !== extraProps.githubLogin ||
    props.instanceId !== extraProps.instanceId ||
    props.authorizationId !== extraProps.authorizationId ||
    !sameStringSet(props.scopes, authScopes) ||
    !sameStringSet(props.scopes, extraProps.scopes) ||
    !authScopes.includes(requiredScope)
  ) {
    throw new Error("MCP authorization denied");
  }

  return {
    clientId: props.clientId,
    audience: props.audience,
    grantedScopes: [...authScopes],
    owner: {
      githubUserId: props.githubUserId,
      githubLogin: props.githubLogin,
      instanceId: props.instanceId,
    },
  };
}
