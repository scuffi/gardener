// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunDetailResponse } from "../../lib/types";

/**
 * Render smoke tests for the run detail surface.
 *
 * These exercise the task tree, the retry callout and the effect receipts against a realistic
 * payload, because those are the parts most likely to break silently on real data shapes.
 */

const api = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../lib/api", () => ({ gardenerApi: { run: api.run } }));

import { RunDetailPage } from "./run-detail-page";

const stamp = "2026-09-11 10:00:00";

const payload: RunDetailResponse = {
  run: {
    id: "run_0123456789abcdef",
    kind: "issue.triage",
    agent_id: "agent_triage",
    status: "completed",
    harness_id: "harness_default",
    created_at: stamp,
    started_at: stamp,
    completed_at: "2026-09-11 10:02:30",
  },
  tasks: [
    {
      id: "task_root",
      parent_task_id: null,
      stable_key: "root",
      kind: "plan",
      status: "completed",
      parallel_group: null,
      depth: 0,
      created_at: stamp,
    },
    {
      id: "task_child",
      parent_task_id: "task_root",
      stable_key: "fanout.a",
      kind: "analyze",
      status: "completed",
      parallel_group: "grp1",
      depth: 1,
      created_at: stamp,
    },
  ],
  steps: [
    {
      id: "step_1",
      task_id: "task_root",
      stable_key: "plan.compose",
      kind: "model.call",
      status: "completed",
      attempt_count: 3,
      max_attempts: 5,
      created_at: stamp,
    },
  ],
  effects: [
    {
      id: "effect_1",
      operation_id: "op_abcdef123456789",
      effect_kind: "issue.comment.create",
      policy_mode: "auto",
      status: "executed",
      created_at: stamp,
      decided_at: stamp,
      executed_at: stamp,
    },
  ],
};

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/runs/run_0123456789abcdef"]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  api.run.mockReset();
});

describe("Run detail", () => {
  it("renders identity, the task tree, retries and effect receipts", async () => {
    api.run.mockResolvedValue(payload);
    renderDetail();

    await waitFor(() => expect(screen.getByText("Task graph")).toBeTruthy());

    // Task tree, including the concurrent group. `root` appears in both the graph and the step
    // timeline heading, which is intended, so assert presence rather than uniqueness.
    expect(screen.getAllByText("root").length).toBeGreaterThan(0);
    expect(screen.getByText("fanout.a")).toBeTruthy();
    expect(screen.getByText("Parallel")).toBeTruthy();

    // attempt_count 3 means two retries, and that must be visible.
    expect(screen.getByText("2 retries")).toBeTruthy();
    expect(screen.getByText("Attempt 3 of 5")).toBeTruthy();

    // Effects are the audit receipt: the admitting policy mode must be shown.
    expect(screen.getByText("Effects and receipts")).toBeTruthy();
    expect(screen.getByText("issue.comment.create")).toBeTruthy();
    expect(screen.getByText("auto")).toBeTruthy();

    // Summary strip counts.
    expect(screen.getByText("Retries")).toBeTruthy();
    expect(screen.getByText("of 1 proposed")).toBeTruthy();
  });

  it("recovers gracefully from an unknown run id", async () => {
    api.run.mockRejectedValue(new Error("Run not found"));
    renderDetail();

    await waitFor(() => expect(screen.getByText("Run unavailable")).toBeTruthy());
    expect(screen.getByText("Run not found")).toBeTruthy();
    // A dead end is not acceptable; there must be a way back.
    expect(screen.getByRole("link", { name: /All runs/ })).toBeTruthy();
  });

  it("handles a run with no tasks, steps or effects", async () => {
    api.run.mockResolvedValue({ ...payload, tasks: [], steps: [], effects: [] });
    renderDetail();

    await waitFor(() => expect(screen.getByText("No steps were recorded")).toBeTruthy());
    expect(screen.getByText("No effects were proposed")).toBeTruthy();
  });
});
