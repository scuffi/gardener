// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, type ReactNode } from "react";
import { Link as RouterLink, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  agentAssignments: vi.fn(),
  actionsRuns: vi.fn(),
  runs: vi.fn(),
}));

vi.mock("./lib/api", () => ({ gardenerApi: api }));

import { AgentsPage } from "./features/agents/agents-page";
import { RunsPage } from "./features/runs/runs-page";
import { LinkProvider, type LinkComponentProps } from "./primitives";

const TestLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
  ({ href, to: _to, ...props }, ref) => <RouterLink ref={ref} to={href ?? ""} {...props} />,
);
TestLink.displayName = "TestLink";

function renderWithData(children: ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <LinkProvider component={TestLink}>
          <Routes>
            <Route path={path} element={children} />
            <Route path="/runs/:id" element={<p>Selected run</p>} />
          </Routes>
        </LinkProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("clickable collection surfaces", () => {
  it("makes the complete Agent card a named navigation target", async () => {
    api.agents.mockResolvedValue({
      agents: [
        {
          id: "agent_1",
          name: "Issue gardener",
          description: "Tends newly opened issues.",
          lifecycle: "active",
          enabled: true,
          latestRevision: 2,
          updatedAt: "2026-09-14 08:00:00",
        },
      ],
    });
    api.agentAssignments.mockResolvedValue({ assignmentEpoch: 1, assignments: [] });
    renderWithData(<AgentsPage />, "/agents");

    const card = await screen.findByRole("link", { name: "Open Agent Issue gardener" });
    expect(card.getAttribute("href")).toBe("/agents/agent_1");
    expect(card.textContent).toContain("Tends newly opened issues.");
  });

  it("opens a run from its full pointer row and native keyboard link", async () => {
    const user = userEvent.setup();
    api.actionsRuns.mockResolvedValue({
      runs: [{
        id: "repo-1-run-2-attempt-1-plan",
        repositoryId: "1",
        githubRunId: "2",
        githubRunAttempt: 1,
        status: "completed",
        outcome: { status: "completed", summary: "README inspected", proposedEffects: [{ kind: "issue.comment.create", body: "Please add a regression test." }] },
        effectReceipt: { operationId: "op_1", commentId: "99", commentUrl: "https://github.com/owner/repo/issues/7#issuecomment-99" },
        createdAt: "2026-09-14 08:00:00",
        updatedAt: "2026-09-14 08:00:04",
      }],
    });
    api.runs.mockResolvedValue({
      runs: [
        {
          id: "run_0123456789abcdef",
          kind: "issue.triage",
          agent_id: "agent_1",
          status: "completed",
          created_at: "2026-09-14 08:00:00",
          started_at: "2026-09-14 08:00:00",
          completed_at: "2026-09-14 08:00:04",
        },
      ],
    });
    renderWithData(<RunsPage />, "/runs");

    expect(await screen.findByText("README inspected")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View GitHub comment" }).getAttribute("href"))
      .toBe("https://github.com/owner/repo/issues/7#issuecomment-99");
    const rowLink = await screen.findByRole("link", {
      name: /Open run run_0123456789abcdef.*Status: Completed.*Kind: issue\.triage/,
    });
    expect(rowLink.getAttribute("href")).toBe("/runs/run_0123456789abcdef");
    const keepModifiedClickInDocument = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("click", keepModifiedClickInDocument, { once: true });
    fireEvent.click(rowLink, { metaKey: true });
    expect(screen.queryByText("Selected run")).toBeNull();
    await user.click(screen.getByText("issue.triage"));
    expect(await screen.findByText("Selected run")).toBeTruthy();
  });
});
