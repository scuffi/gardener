// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ agents: vi.fn(), agentAssignments: vi.fn() }));
vi.mock("../../lib/api", async (original) => {
  const actual = await original<typeof import("../../lib/api")>();
  return { ...actual, gardenerApi: api };
});

import { AgentsPage } from "./agents-page";

const agent = {
  id: "agent-one",
  slug: "one",
  name: "Agent One",
  description: "Human description",
  enabled: false,
  lifecycle: "active" as const,
  activeRevision: 1,
  latestRevision: 1,
  hasDraft: false,
  updatedAt: "2026-09-15T00:00:00Z",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agent deployment list", () => {
  it("shows loading and empty states", async () => {
    api.agents.mockReturnValue(new Promise(() => undefined));
    const first = renderPage();
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    first.unmount();

    api.agents.mockResolvedValue({ agents: [] });
    renderPage();
    expect(await screen.findByText("No Agents yet")).toBeTruthy();
    const create = screen.getAllByRole("link", { name: "New Agent" })[0]!;
    expect(create.className).toContain("max-md:min-h-11");
    expect(create.className).toContain("max-md:min-w-11");
  });

  it("shows assignment counts and a repository filter", async () => {
    api.agents.mockResolvedValue({ agents: [agent] });
    api.agentAssignments.mockResolvedValue({
      assignmentEpoch: 4,
      assignments: [
        {
          schemaVersion: "v1",
          id: "assignment-one",
          version: 1,
          configHash: "a".repeat(64),
          agentId: agent.id,
          repositoryId: "10",
          repositoryDisplayName: "acme/widgets",
          enabled: true,
          authorityCeiling: "approval",
          createdAt: "2026-09-15T00:00:00Z",
          updatedAt: "2026-09-15T00:00:00Z",
          removedAt: null,
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("1 of 1 deployments enabled")).toBeTruthy();
    const filter = screen.getByLabelText("Filter Agents by repository");
    expect(filter.className).toContain("max-md:min-h-11");
    expect(filter.className).toContain("max-md:min-w-11");
  });

  it("does not offer removed-only repositories as filters", async () => {
    api.agents.mockResolvedValue({ agents: [agent] });
    api.agentAssignments.mockResolvedValue({
      assignmentEpoch: 4,
      assignments: [
        {
          schemaVersion: "v1",
          id: "removed-assignment",
          version: 2,
          configHash: "a".repeat(64),
          agentId: agent.id,
          repositoryId: "10",
          repositoryDisplayName: "acme/removed",
          enabled: false,
          authorityCeiling: "approval",
          createdAt: "2026-09-15T00:00:00Z",
          updatedAt: "2026-09-15T00:00:00Z",
          removedAt: "2026-09-15T01:00:00Z",
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("No repository deployments")).toBeTruthy();
    expect(screen.queryByLabelText("Filter Agents by repository")).toBeNull();
  });

  it("renders assignment query failures instead of a no-deployments status", async () => {
    api.agents.mockResolvedValue({ agents: [agent] });
    api.agentAssignments.mockRejectedValue(new Error("Assignments failed"));
    renderPage();
    expect(await screen.findByText("Assignments failed")).toBeTruthy();
    expect(screen.queryByText("No repository deployments")).toBeNull();
  });

  it("shows a retryable error", async () => {
    api.agents.mockRejectedValue(new Error("Agent list failed"));
    renderPage();
    expect(await screen.findByText("Agent list failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
