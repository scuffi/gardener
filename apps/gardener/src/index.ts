// Keep Gardener's authenticated Worker as the authored main while exporting
// the one generic class for each runtime/workspace adapter.
export * from "./app";
export { ComputerWorkspace } from "./workspace/computer-workspace";
export { WorkspaceProxy, WorkspaceServiceProxy } from "./workspace/exports";
export { AgentRunWorkflow } from "./runtime";
export * from "virtual:flue/worker";

import { gardenerWorker } from "./app";
export default gardenerWorker;
