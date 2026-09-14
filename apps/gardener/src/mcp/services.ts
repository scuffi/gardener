import type { GardenerMcpScope } from "./scopes";
import type {
  CatalogInput,
  DiffInput,
  ExplainInput,
  GetAgentInput,
  GetRunTraceInput,
  ListAgentsInput,
  PublishDraftInput,
  SimulateInput,
  ValidateInput,
} from "./schemas";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** The only identity and authorization data that persistence services receive. */
export interface GardenerMcpPrincipal {
  clientId: string;
  audience: string;
  grantedScopes: GardenerMcpScope[];
  owner: {
    githubUserId: string;
    githubLogin: string;
    instanceId: string;
  };
}

export interface ActiveGardenerMcpPrincipal extends GardenerMcpPrincipal {
  userId: string;
  role: "owner" | "member";
  principalKind: "mcp-token";
}

export interface AgentSummary extends JsonObject {
  id: string;
  name: string;
  lifecycle: string;
}

export interface AgentListResult extends JsonObject {
  agents: AgentSummary[];
  nextCursor: string | null;
}

export interface AgentAuthoringService {
  list(input: ListAgentsInput, principal: GardenerMcpPrincipal): Promise<AgentListResult>;
  get(input: GetAgentInput, principal: GardenerMcpPrincipal): Promise<JsonObject>;
  catalog(input: CatalogInput, principal: GardenerMcpPrincipal): Promise<JsonObject>;
  validate(input: ValidateInput, principal: GardenerMcpPrincipal): Promise<JsonObject>;
  explain(input: ExplainInput, principal: GardenerMcpPrincipal): Promise<JsonObject>;
  diff(input: DiffInput, principal: GardenerMcpPrincipal): Promise<JsonObject>;
  simulate(input: SimulateInput, principal: GardenerMcpPrincipal): Promise<JsonObject>;

  /**
   * This is intentionally the only mutation exposed to MCP. Implementations must
   * validate source and may only create or update a mutable, paused draft.
   */
  savePausedDraft(input: PublishDraftInput, principal: GardenerMcpPrincipal): Promise<PausedDraftReceipt>;
}

export interface PausedDraftReceipt extends JsonObject {
  lifecycle: "paused_draft";
  draftId: string;
  contentHash: string;
  updatedAt: string;
  active: false;
  enabled: false;
  immutableRevisionCreated: false;
}

export interface RunTraceService {
  /** Returns a product-redacted trace. The MCP boundary applies a second redaction pass. */
  getTrace(input: GetRunTraceInput, principal: GardenerMcpPrincipal): Promise<JsonObject>;
}

export interface GardenerMcpServices {
  agents: AgentAuthoringService;
  runs: RunTraceService;
}

export interface GardenerMcpAuthorizedServices extends GardenerMcpServices {
  /** Re-resolved for every invocation; OAuth scopes are necessary but never sufficient. */
  resolvePrincipal(principal: GardenerMcpPrincipal): Promise<ActiveGardenerMcpPrincipal | null>;
}
