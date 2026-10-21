import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../../..");

describe("the chat destination in Gardener's task workflow", () => {
  it("is an optional secret that only the apply bridge step receives", async () => {
    const source = await readFile(join(root, ".github/workflows/gardener-task.yml"), "utf8");
    const workflow = parse(source) as {
      on: { workflow_call: { secrets?: Record<string, { required?: boolean }> } };
      jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, string>; env?: Record<string, string> }> }>;
    };
    expect(workflow.on.workflow_call.secrets?.["chat-webhook"]).toMatchObject({ required: false });
    // Exactly one interpolation in the whole file: the planning job, which
    // runs the model and task commands, must never see it.
    expect(source.match(/secrets\.chat-webhook/g)).toHaveLength(1);
    const holders = Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) => steps
      .filter((step) => JSON.stringify(step).includes("secrets.chat-webhook"))
      .map((step) => ({ job, uses: step.uses, input: step.with?.["chat-webhook"] })));
    expect(holders).toHaveLength(1);
    expect(holders[0]!.uses).toMatch(/^scuffi\/gardener\/bridges\/github\/apply@[0-9a-f]{40}$/);
    expect(holders[0]!.input).toBe("${{ secrets.chat-webhook }}");
  });

  it("is declared, optional, by the apply bridge action", async () => {
    const action = parse(await readFile(join(root, "bridges/github/apply/action.yml"), "utf8")) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
    };
    expect(action.inputs["chat-webhook"]).toMatchObject({ required: false, default: "" });
  });
});
