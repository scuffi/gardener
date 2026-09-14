// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, HealthState } from "./lib/types";

const harness = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  api: {
    setPaused: vi.fn(),
    setRepositoryPaused: vi.fn(),
    inbox: vi.fn(),
    respondToInbox: vi.fn(),
    agent: vi.fn(),
    agentRevision: vi.fn(),
    activateAgentRevision: vi.fn(),
    setAgentEnabled: vi.fn(),
    activate: vi.fn(),
    setPolicies: vi.fn(),
  },
  notify: vi.fn(),
}));

vi.mock("./app-context", () => ({ useGardener: () => harness.context }));
vi.mock("./lib/api", () => ({ gardenerApi: harness.api }));
vi.mock("./providers/notifications", () => ({
  useNotifications: () => ({ notify: harness.notify }),
}));

import { AgentDetailPage } from "./features/agents/agent-detail-page";
import { InboxPage } from "./features/inbox/inbox-page";
import { PoliciesPage } from "./features/policies/policies-page";
import { SetupWizard } from "./features/setup/setup-wizard";
import { AutomationMenu } from "./shell/automation-menu";

const now = "2026-09-14 10:00:00";
const health: HealthState = {
  ok: true,
  database: true,
  workersAi: true,
  connectConfigured: true,
  localDevelopment: true,
  agentRuntime: { enabled: true, status: "bounded-issue-comment-v3" },
};
const state: AppState = {
  globalPaused: true,
  viewer: { login: "octocat" },
  setup: { completed: true, profile: "safe", activeRepositories: 1 },
  policies: [{ operation_kind: "issue.comment.create", mode: "disabled" }],
  repositories: [
    {
      id: "repository_1",
      owner: "cloudflare",
      name: "workers-sdk",
      active: 1,
      paused: true,
    },
  ],
};
const agent = {
  id: "agent_1",
  slug: "issue-gardener",
  name: "Issue gardener",
  description: "Reviews issues",
  enabled: false,
  lifecycle: "active" as const,
  activeRevision: 1,
  latestRevision: 2,
  hasDraft: false,
  updatedAt: now,
};
const agentDetail = {
  agent,
  draft: null,
  revisions: [
    {
      id: "revision_1",
      revision: 1,
      sourceHash: "a".repeat(64),
      publishedAt: now,
      active: true,
    },
    {
      id: "revision_2",
      revision: 2,
      sourceHash: "b".repeat(64),
      publishedAt: now,
      active: false,
    },
  ],
};

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
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

beforeEach(() => {
  vi.clearAllMocks();
  harness.context = {
    state,
    health,
    stateLoading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  };
  harness.api.setPaused.mockResolvedValue({ globalPaused: false });
  harness.api.setRepositoryPaused.mockResolvedValue({ id: "repository_1", paused: false });
  harness.api.respondToInbox.mockResolvedValue({ item: { id: "inbox_1", status: "resolved" } });
  harness.api.agent.mockResolvedValue(agentDetail);
  harness.api.agentRevision.mockResolvedValue({
    revision: 2,
    sourceMd: "---\nname: Issue gardener\n---",
    sourceHash: "b".repeat(64),
  });
  harness.api.activateAgentRevision.mockResolvedValue({ activated: true });
  harness.api.setAgentEnabled.mockResolvedValue({ enabled: true });
  harness.api.activate.mockResolvedValue({ activated: true, profile: "safe" });
  harness.api.setPolicies.mockResolvedValue({
    policies: [{ operation: "issue.comment.create", mode: "approval" }],
  });
});

afterEach(cleanup);

function renderAt(element: ReactElement, path = "/", routePattern = "*") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePattern} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function confirmExact(label: string) {
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: label }));
}

describe("authority-widening action guards", () => {
  it("guards global and repository resume while global pause stays immediate", async () => {
    const user = userEvent.setup();
    renderAt(<AutomationMenu />);

    await user.click(screen.getByRole("button", { name: /Gardener paused.*automation controls/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Resume Gardener globally" }));
    expect(harness.api.setPaused).not.toHaveBeenCalled();
    await confirmExact("Resume Gardener globally");
    await waitFor(() =>
      expect(harness.api.setPaused).toHaveBeenCalledWith(false, expect.anything()),
    );

    cleanup();
    harness.context = {
      ...harness.context,
      state: { ...state, globalPaused: false },
    };
    renderAt(<AutomationMenu />);
    await user.click(screen.getByRole("button", { name: /automation controls/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Pause Gardener globally" }));
    await waitFor(() =>
      expect(harness.api.setPaused).toHaveBeenCalledWith(true, expect.anything()),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();

    cleanup();
    harness.api.setRepositoryPaused.mockClear();
    renderAt(<AutomationMenu />);
    await user.click(screen.getByRole("button", { name: /automation controls/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /cloudflare\/workers-sdk/ }),
    );
    expect(harness.api.setRepositoryPaused).not.toHaveBeenCalled();
    await confirmExact("Resume cloudflare/workers-sdk");
    await waitFor(() =>
      expect(harness.api.setRepositoryPaused).toHaveBeenCalledWith("repository_1", false),
    );
    expect(screen.queryByText("Resume Gardener globally?")).toBeNull();
  });

  it("guards Inbox approval while rejection stays immediate", async () => {
    harness.api.inbox.mockResolvedValue({
      items: [
        {
          id: "inbox_1",
          kind: "effect",
          status: "open",
          priority: "urgent",
          title: "Post one exact issue comment",
          summary: "Review the bounded comment.",
          createdAt: now,
          actions: ["approve", "reject"],
        },
      ],
    });
    renderAt(<InboxPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Approve exact request" }));
    expect(harness.api.respondToInbox).not.toHaveBeenCalled();
    await confirmExact("Approve exact request");
    await waitFor(() =>
      expect(harness.api.respondToInbox).toHaveBeenCalledWith("inbox_1", "approve"),
    );
    expect(screen.queryByText("Review the bounded request before approving it.")).toBeNull();

    cleanup();
    harness.api.respondToInbox.mockClear();
    renderAt(<InboxPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject exact request" }));
    await waitFor(() =>
      expect(harness.api.respondToInbox).toHaveBeenCalledWith("inbox_1", "reject"),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("guards revision activation and Agent enable while disable stays immediate", async () => {
    renderAt(
      <AgentDetailPage />,
      "/agents/agent_1/revisions/2",
      "/agents/:id/revisions/:revision",
    );
    await userEvent.click(await screen.findByRole("button", { name: "Activate revision" }));
    expect(harness.api.activateAgentRevision).not.toHaveBeenCalled();
    await confirmExact("Activate revision 2");
    await waitFor(() =>
      expect(harness.api.activateAgentRevision).toHaveBeenCalledWith("agent_1", 2),
    );
    expect(screen.queryByText("Enable this Agent?")).toBeNull();

    cleanup();
    harness.api.agent.mockResolvedValue(agentDetail);
    renderAt(<AgentDetailPage />, "/agents/agent_1", "/agents/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Enable Agent" }));
    expect(harness.api.setAgentEnabled).not.toHaveBeenCalled();
    await confirmExact("Enable Agent");
    await waitFor(() =>
      expect(harness.api.setAgentEnabled).toHaveBeenCalledWith("agent_1", true),
    );

    cleanup();
    harness.api.setAgentEnabled.mockClear();
    harness.api.agent.mockResolvedValue({
      ...agentDetail,
      agent: { ...agent, enabled: true },
    });
    renderAt(<AgentDetailPage />, "/agents/agent_1", "/agents/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Disable Agent" }));
    await waitFor(() =>
      expect(harness.api.setAgentEnabled).toHaveBeenCalledWith("agent_1", false),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cannot execute a broader fallback after a guard dialog is dismissed", async () => {
    const user = userEvent.setup();
    harness.context = {
      ...harness.context,
      state: { ...state, globalPaused: false },
    };
    renderAt(<AutomationMenu />);
    await user.click(screen.getByRole("button", { name: /automation controls/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /cloudflare\/workers-sdk/ }),
    );
    const repositoryDialog = await screen.findByRole("alertdialog");
    const staleRepositoryConfirm = within(repositoryDialog).getByRole("button", {
      name: "Resume cloudflare/workers-sdk",
    });
    await user.click(within(repositoryDialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(staleRepositoryConfirm);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.api.setRepositoryPaused).not.toHaveBeenCalled();
    expect(harness.api.setPaused).not.toHaveBeenCalled();

    cleanup();
    renderAt(
      <AgentDetailPage />,
      "/agents/agent_1/revisions/2",
      "/agents/:id/revisions/:revision",
    );
    await user.click(await screen.findByRole("button", { name: "Activate revision" }));
    const revisionDialog = await screen.findByRole("alertdialog");
    const staleRevisionConfirm = within(revisionDialog).getByRole("button", {
      name: "Activate revision 2",
    });
    await user.click(within(revisionDialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(staleRevisionConfirm);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.api.activateAgentRevision).not.toHaveBeenCalled();
    expect(harness.api.setAgentEnabled).not.toHaveBeenCalled();
  });

  it("guards setup activation before applying policies and resuming globally", async () => {
    harness.context = {
      ...harness.context,
      state: {
        ...state,
        setup: { completed: false, profile: "safe", activeRepositories: 1 },
      },
    };
    renderAt(<SetupWizard />);

    await userEvent.click(screen.getByRole("button", { name: "Review and finish setup" }));
    expect(harness.api.activate).not.toHaveBeenCalled();
    await confirmExact("Apply profile and finish setup");
    await waitFor(() => expect(harness.api.activate).toHaveBeenCalledWith("safe"));
  });

  it("guards every policy change that increases the authority rank", async () => {
    renderAt(<PoliciesPage />);

    await userEvent.click(screen.getByRole("radio", { name: "Require approval" }));
    await userEvent.click(screen.getByRole("button", { name: "Save policies" }));
    expect(harness.api.setPolicies).not.toHaveBeenCalled();
    await confirmExact("Allow and save");
    await waitFor(() =>
      expect(harness.api.setPolicies).toHaveBeenCalledWith([
        { operation: "issue.comment.create", mode: "approval" },
      ]),
    );
  });
});
