// Keep Gardener's authenticated Worker as the authored main while exporting
// the one generic class for each runtime/workspace adapter.
export * from "./app";
export { ComputerWorkspace } from "./workspace/computer-workspace";
export { WorkspaceProxy, WorkspaceServiceProxy } from "./workspace/exports";
export { GardenerGitHubEntrypoint } from "./providers/github/ingress";
export { TaskRunnerSession } from "./task-runtime/session";
export { GardenerRunnerIngressEntrypoint } from "./task-runtime/ingress-entrypoint";
export * from "virtual:flue/worker";

// Register the additive Actions-native task harness without routing its
// conversation surface publicly.
import "./task-runtime/flue-agent";
import { gardenerWorker } from "./app";
export default gardenerWorker;
