// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { axe } from "vitest-axe";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  api: {
    agent: vi.fn(),
    agentRevision: vi.fn(),
    agentAssignments: vi.fn(),
    activateAgentRevisionWithPreconditions: vi.fn(),
  },
  context: {
    session: {
      authenticated: true as const,
      user: { role: "owner" as const },
    },
  },
  notify: vi.fn(),
}));

vi.mock("../../app-context", () => ({ useGardener: () => harness.context }));
vi.mock("../../lib/api", async (original) => {
  const actual = await original<typeof import("../../lib/api")>();
  return { ...actual, gardenerApi: harness.api };
});
vi.mock("../../providers/notifications", () => ({
  useNotifications: () => ({ notify: harness.notify }),
}));
vi.mock("./components/agent-deployments", () => ({
  AgentDeployments: () => <div>Repository deployments</div>,
}));

import { AgentDetailPage } from "./agent-detail-page";

const detail = {
  agent: {
    id: "agent-one",
    slug: "one",
    name: "Agent One",
    description: "Human description",
    enabled: false,
    lifecycle: "active" as const,
    activeRevision: 2,
    latestRevision: 2,
    hasDraft: true,
    updatedAt: "2026-09-15T00:00:00Z",
  },
  draft: { id: "draft-one", sourceMd: "draft" },
  sourceMd: "published",
  revisions: [
    {
      id: "revision-two",
      revision: 2,
      sourceHash: "a".repeat(64),
      publishedAt: "2026-09-15T00:00:00Z",
      publishedBy: "Human Publisher",
      active: true,
    },
    {
      id: "revision-one",
      revision: 1,
      sourceHash: "b".repeat(64),
      publishedAt: "2026-09-14T00:00:00Z",
      publishedBy: "Earlier Publisher",
      active: false,
    },
  ],
};

function renderDetail() {
  harness.api.agent.mockResolvedValue(detail);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/agents/agent-one"]}>
        <Routes>
          <Route path="/agents/:id" element={<AgentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agent revision history responsive layout", () => {
  it("separates the desktop table from complete mobile revision cards", async () => {
    renderDetail();
    const desktop = await screen.findByTestId("revision-desktop-table");
    const mobile = screen.getByTestId("revision-mobile-list");

    expect(desktop.className).toContain("hidden");
    expect(desktop.className).toContain("md:block");
    expect(within(desktop).getByRole("table").className).toContain("min-w-[620px]");
    expect(mobile.className).toContain("md:hidden");
    expect(mobile.querySelector('[class*="min-w-[620px]"]')).toBeNull();
    expect(within(mobile).getAllByText("Published")).toHaveLength(2);
    expect(within(mobile).getByText("Human Publisher")).toBeTruthy();
    expect(within(mobile).getByText("Earlier Publisher")).toBeTruthy();
    const review = within(mobile).getByRole("button", { name: "Review" });
    expect(review.className).toContain("min-h-11");
    expect(review.className).toContain("min-w-11");
  });

  it("keeps Agent page controls touch-sized and has no serious Axe violations", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    const { container } = renderDetail();
    const mobile = await screen.findByTestId("revision-mobile-list");
    expect(within(mobile).getByText("Earlier Publisher")).toBeTruthy();
    const edit = screen.getByRole("button", { name: "Edit draft" });
    expect(edit.className).toContain("max-md:min-h-11");
    expect(edit.className).toContain("max-md:min-w-11");

    const results = await axe(container);
    expect(
      results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? "")),
    ).toEqual([]);
  });
});
