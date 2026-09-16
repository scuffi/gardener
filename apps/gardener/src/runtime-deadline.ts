import { FLUE_NATIVE_DURABILITY_TIMEOUT_MS } from "./flue-native-protocol";

export const MAX_FLUE_RUNTIME_MS = FLUE_NATIVE_DURABILITY_TIMEOUT_MS;

/** Freeze the per-submission deadline below the explicit Flue Agent ceiling. */
export function boundedModelRuntimeMs(runtimeSeconds: number): number {
  return Math.min(runtimeSeconds * 1_000, MAX_FLUE_RUNTIME_MS);
}
