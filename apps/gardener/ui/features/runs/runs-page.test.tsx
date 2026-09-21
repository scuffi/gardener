// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionsTaskRunSummary } from "../../lib/types";

const api = vi.hoisted(() => ({
  actionsRuns: vi.fn(),
  runs: vi.fn(),
}));
const context = vi.hoisted(() => ({
  health: { deploymentMode: "actions-v1" as const },
}));

vi.mock("../../app-context", () => ({ useGardener: () => context }));
vi.mock("../../lib/api", () => ({ gardenerApi: api }));

import { RunsPage } from "./runs-page";

const actionRun: ActionsTaskRunSummary = {
  id: "task-run-1",
  repositoryId: "1374842705",
  githubRunId: "35369214475",
  githubRunAttempt: 1,
  status: "completed",
  outcome: {
    status: "completed",
    summary: "Triaged the issue from repository evidence.",
    proposedEffects: [{ kind: "issue.comment.create", body: "The proposed triage comment." }],
  },
  effectReceipt: {
    planRunId: "task-run-1",
    bundleHash: "d3ea6c38276b0e67f6757354abbd60afc596eaafd0702622eaa8ca95499f849f",
    artifactSha256: "f2f365045ffddc7f04bf2957bb327f946b07c149d52036988999321e0bc2605a",
    operationId: "op_f2f365045ffddc7f04bf2957bb327f946b07c149d52036988999321e0bc2605a",
    kind: "issue.comment.create",
    commentId: "5733064172",
    commentUrl: "https://github.com/scuffi/example/issues/12#issuecomment-5733064172",
  },
  createdAt: "2026-09-18 10:00:00",
  updatedAt: "2026-09-18 10:01:00",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Actions-native Runs", () => {
  it("renders only the Actions outcome and its exact effect identities", async () => {
    api.actionsRuns.mockResolvedValue({ runs: [actionRun] });
    renderPage();

    await waitFor(() => expect(screen.getByText(actionRun.outcome!.summary!)).toBeTruthy());
    expect(screen.getByText("The proposed triage comment.")).toBeTruthy();
    expect(screen.getByText(actionRun.effectReceipt!.operationId)).toBeTruthy();
    expect(screen.getByText(actionRun.effectReceipt!.artifactSha256)).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub comment 5733064172" })).toHaveProperty(
      "href",
      actionRun.effectReceipt!.commentUrl,
    );
    expect(api.runs).not.toHaveBeenCalled();
    expect(screen.queryByText("No runs have started")).toBeNull();
  });
});
