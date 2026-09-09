import type { AgentHarness, HarnessId } from "./types";
import { HARNESS_ADAPTER_VERSIONS, HARNESS_IDS } from "./types";
import { HarnessContractError } from "./validation";

export const DEFAULT_HARNESS_ID: HarnessId = "flue";

export interface HarnessFactoryOptions {
  flue: AgentHarness;
  think: AgentHarness;
  cloudflareAgents: AgentHarness;
}

export function createHarnessRegistry(options: HarnessFactoryOptions): HarnessRegistry {
  return new HarnessRegistry([options.flue, options.think, options.cloudflareAgents]);
}

export class HarnessRegistry {
  private readonly adapters: ReadonlyMap<HarnessId, AgentHarness>;

  constructor(adapters: readonly AgentHarness[]) {
    const byId = new Map<HarnessId, AgentHarness>();
    for (const adapter of adapters) {
      const id = adapter.descriptor.id;
      if (byId.has(id)) throw new HarnessContractError("invalid-request", `Duplicate harness adapter ${id}`);
      if (adapter.descriptor.adapterVersion !== HARNESS_ADAPTER_VERSIONS[id]) {
        throw new HarnessContractError(
          "invalid-request",
          `Harness ${id} has adapter version ${adapter.descriptor.adapterVersion}; expected ${HARNESS_ADAPTER_VERSIONS[id]}`,
        );
      }
      byId.set(id, adapter);
    }
    this.adapters = byId;
  }

  get(id: HarnessId): AgentHarness {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new HarnessContractError("integration-unavailable", `Harness ${id} is not configured`);
    return adapter;
  }

  select(setting: string | null | undefined): AgentHarness {
    const id = setting === null || setting === undefined || setting === "" ? DEFAULT_HARNESS_ID : setting;
    if (!HARNESS_IDS.includes(id as HarnessId)) {
      throw new HarnessContractError("invalid-request", `Unknown harness setting ${id}`);
    }
    return this.get(id as HarnessId);
  }

  list(): readonly AgentHarness[] {
    return [...this.adapters.values()];
  }
}
