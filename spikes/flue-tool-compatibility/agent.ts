"use agent";

import {
  useAgentFinish,
  useInitialData,
  useInstruction,
  useModel,
  usePersistentState,
  useResponseFinish,
  useTool,
} from "@flue/runtime";
import * as v from "valibot";

const SENTINEL = "GARDENER_CANONICAL_READ_RESULT";
const LIST_TOOL = "repository_list_files";
const READ_TOOL = "repository_read_file";
const TERMINAL_TOOL = "submit_probe_result";

interface ProbeInitialData {
  model: string;
  pauseMs?: number;
  mode?: "exact" | "broad";
}

interface ProbeStep {
  tool: string;
  detail: string;
}

export function CanonicalToolProbe(): string {
  const initial = useInitialData<ProbeInitialData>();
  if (!initial?.model?.startsWith("@cf/")) throw new Error("Probe model must be a Workers AI model");
  const [steps, setSteps] = usePersistentState<ProbeStep[]>("probeSteps", []);

  useModel(`cloudflare/${initial.model}`, { compaction: false });
  useInstruction((initial.mode ?? "exact") === "exact" ? [
    `Call ${LIST_TOOL} first.`,
    `Then call ${READ_TOOL} with path README.md.`,
    `Finally call ${TERMINAL_TOOL} with the exact evidence string returned by ${READ_TOOL}.`,
    "Do not skip, reorder, or parallelize these tools.",
    "Do not answer with assistant text. The terminal tool must end the run.",
  ].join("\n") : [
    "Inspect the repository using the available tools and prepare a useful issue comment.",
    "All tools remain visible. Choose their order and arguments yourself.",
    `Finish by calling ${TERMINAL_TOOL} with the exact evidence returned by ${READ_TOOL}.`,
    "Do not answer with assistant text.",
  ].join("\n"));

  useTool({
    name: LIST_TOOL,
    description: "List the repository files. This must be called before reading a file.",
    input: v.strictObject({}),
    output: v.strictObject({ files: v.array(v.string()) }),
    durable: true,
    async run() {
      if (steps.length !== 0) throw new Error("list_files_out_of_order");
      if ((initial.pauseMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, initial.pauseMs));
      setSteps([{ tool: LIST_TOOL, detail: "README.md" }]);
      return { output: { files: ["README.md", "src/index.ts"] } };
    },
  });

  useTool({
    name: READ_TOOL,
    description: "Read one listed repository file. Read README.md after listing files.",
    input: v.strictObject({ path: v.literal("README.md") }),
    output: v.strictObject({ path: v.string(), content: v.string() }),
    durable: true,
    async run({ data }) {
      if (steps.length !== 1 || steps[0]?.tool !== LIST_TOOL) throw new Error("read_file_out_of_order");
      const next = [...steps, { tool: READ_TOOL, detail: data.path }];
      setSteps(next);
      return {
        output: {
          path: data.path,
          content: `${SENTINEL}: canonical tool continuation reached the model`,
        },
      };
    },
  });

  useTool({
    name: TERMINAL_TOOL,
    description: "Submit the final probe result after list_files and read_file. Copy the read evidence exactly.",
    input: v.strictObject({
      summary: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
      evidence: v.literal(`${SENTINEL}: canonical tool continuation reached the model`),
    }),
    output: v.strictObject({ accepted: v.boolean() }),
    durable: true,
    async run({ data }) {
      if (steps.length !== 2 || steps[0]?.tool !== LIST_TOOL || steps[1]?.tool !== READ_TOOL) {
        throw new Error("terminal_tool_out_of_order");
      }
      setSteps([...steps, { tool: TERMINAL_TOOL, detail: data.evidence }]);
      return { output: { accepted: true }, terminate: true };
    },
  });

  useAgentFinish(({ response, append }) => {
    const successful = response.toolCalls.filter((call) => !call.isError).map((call) => call.tool);
    if (successful.at(-1) === TERMINAL_TOOL) return;
    if ((initial.mode ?? "exact") === "broad") {
      append({
        kind: "signal",
        type: "probe.terminal-required",
        body: `Call ${TERMINAL_TOOL} now with the exact read evidence; do not answer with text.`,
      });
      return;
    }
    throw new Error("probe_completed_without_terminal_tool");
  });

  useResponseFinish(({ response }) => ({
    probe: {
      model: initial.model,
      successfulTools: response.toolCalls.filter((call) => !call.isError).map((call) => call.tool),
      failedTools: response.toolCalls.filter((call) => call.isError).map((call) => call.tool),
      inputTokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
      outputTokens: response.usage.output,
    },
  }));

  return "Execute the canonical tool-continuation probe now.";
}

CanonicalToolProbe.agentName = "canonical-tool-probe";
CanonicalToolProbe.initialData = v.object({
  model: v.string(),
  pauseMs: v.optional(v.number()),
  mode: v.optional(v.picklist(["exact", "broad"])),
});
CanonicalToolProbe.durability = { maxAttempts: 2, timeoutMs: 180_000 };
