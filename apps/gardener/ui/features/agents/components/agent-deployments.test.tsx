// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api";
import type { WorkspaceRole } from "../../../lib/types";

const harness = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  api: {
    agentAssignments: vi.fn(),
    addAgentAssignments: vi.fn(),
    addAllCurrentAgentAssignments: vi.fn(),
    updateAssignmentState: vi.fn(),
    updateAssignmentAuthority: vi.fn(),
  },
  notify: vi.fn(),
}));

vi.mock("../../../app-context", () => ({ useGardener: () => harness.context }));
vi.mock("../../../lib/api", async (original) => {
  const actual = await original<typeof import("../../../lib/api")>();
  return { ...actual, gardenerApi: harness.api };
});
vi.mock("../../../providers/notifications", () => ({
  useNotifications: () => ({ notify: harness.notify }),
}));

import { AgentDeployments } from "./agent-deployments";

const repositories = [
  { id: "10", owner: "acme", name: "widgets", active: 1 as const, paused: false },
  { id: "11", owner: "acme", name: "tools", active: 1 as const, paused: false },
];
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
const revisions = [{
  id: "revision-one",
  revision: 1,
  sourceHash: "a".repeat(64),
  publishedAt: "2026-09-15T00:00:00Z",
  active: true,
}];
const assignment = {
  schemaVersion: "v1" as const,
  id: "assignment-secret",
  version: 3,
  configHash: "b".repeat(64),
  agentId: agent.id,
  agentDisplayName: agent.name,
  repositoryId: "10",
  repositoryDisplayName: "acme/widgets",
  enabled: true,
  authorityCeiling: "automatic" as const,
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  removedAt: null,
};

function context(role: WorkspaceRole, local = false) {
  return {
    state: {
      repositories,
      globalPaused: false,
      viewer: { login: "viewer" },
      setup: { completed: true, activeRepositories: 2 },
      policies: [],
    },
    session: {
      authenticated: true,
      githubLogin: local ? "local-developer" : "viewer",
      user: {
        id: local ? "local-development" : "user-one",
        displayName: local ? "Local developer" : "Human Viewer",
        role,
        identity: local
          ? { provider: "local", providerSubject: "local-development", login: "local-developer" }
          : { provider: "github", providerSubject: "1", login: "viewer" },
      },
    },
  };
}

function renderDeployments(
  role: WorkspaceRole = "owner",
  local = false,
  override?: Record<string, unknown>,
) {
  harness.context = { ...context(role, local), ...override };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentDeployments agent={agent} revisions={revisions} />
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

beforeEach(() => {
  vi.clearAllMocks();
  harness.api.agentAssignments.mockResolvedValue({
    assignmentEpoch: 7,
    assignments: [assignment],
  });
  harness.api.addAgentAssignments.mockResolvedValue({
    assignmentEpoch: 8,
    assignments: [assignment],
    materializedRepositoryCount: 1,
  });
  harness.api.addAllCurrentAgentAssignments.mockResolvedValue({
    assignmentEpoch: 8,
    assignments: [assignment],
    materializedRepositoryCount: 2,
  });
  harness.api.updateAssignmentState.mockResolvedValue({
    assignment,
    assignmentEpoch: 8,
    result: "updated",
  });
  harness.api.updateAssignmentAuthority.mockResolvedValue({
    assignment,
    assignmentEpoch: 8,
    result: "updated",
  });
});

afterEach(cleanup);

describe("Agent repository deployments", () => {
  it("shows a human some summary and future-repository boundary", async () => {
    renderDeployments();
    expect(await screen.findByText(/Some \(1 of 2 current\)/)).toBeTruthy();
    expect(screen.getByText(/future repositories are not included/i)).toBeTruthy();
    expect(within(screen.getByTestId("deployment-desktop-table")).getByText("acme/widgets"))
      .toBeTruthy();
    expect(within(screen.getByTestId("deployment-mobile-list")).getByText("acme/widgets"))
      .toBeTruthy();
    expect(screen.queryByText("assignment-secret")).toBeNull();
  });

  it("shows owner widening controls to a local owner", async () => {
    renderDeployments("owner", true);
    const assign = await screen.findByRole("button", { name: "Assign all current" });
    const add = screen.getByRole("button", { name: "Add repository" });
    expect(assign.className).toContain("max-md:min-h-11");
    expect(assign.className).toContain("max-md:min-w-11");
    expect(add.className).toContain("max-md:min-h-11");
    expect(add.className).toContain("max-md:min-w-11");
    for (const name of ["Repository", "Authority ceiling"]) {
      const select = screen.getByLabelText(name);
      expect(select.className).toContain("max-md:min-h-11");
      expect(select.className).toContain("max-md:min-w-11");
    }
  });

  it("hides owner-only controls while members can disable and remove", async () => {
    renderDeployments("member");
    const mobile = await screen.findByTestId("deployment-mobile-list");
    expect(within(mobile).getByText("acme/widgets")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Assign all current" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add repository" })).toBeNull();
    expect(within(mobile).getByRole("button", { name: "Disable" })).toBeTruthy();
    expect(within(mobile).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("keeps soft-removed repositories out of Add and exposes only Re-add", async () => {
    harness.api.agentAssignments.mockResolvedValue({
      assignmentEpoch: 7,
      assignments: [{ ...assignment, enabled: false, removedAt: "2026-09-15T01:00:00Z" }],
    });
    renderDeployments();
    const mobile = await screen.findByTestId("deployment-mobile-list");
    const readd = within(mobile).getByRole("button", { name: "Re-add" });
    expect(readd.className).toContain("min-h-11");
    expect(readd.className).toContain("min-w-11");
    await userEvent.click(screen.getByLabelText("Repository"));
    expect(await screen.findByRole("option", { name: "acme/tools" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "acme/widgets" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Assign all current" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends the exact single-repository body", async () => {
    renderDeployments();
    await userEvent.click(await screen.findByLabelText("Repository"));
    await userEvent.click(await screen.findByRole("option", { name: "acme/tools" }));
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add Agent One to acme/tools" }),
    );
    await waitFor(() =>
      expect(harness.api.addAgentAssignments).toHaveBeenCalledWith("agent-one", {
        repositoryId: "11",
        authorityCeiling: "approval",
        expectedAssignmentEpoch: 7,
        expectedActiveRevisionId: "revision-one",
      }),
    );
  });

  it("sends the exact all-current body and reports materialized count", async () => {
    renderDeployments();
    await userEvent.click(await screen.findByRole("button", { name: "Assign all current" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/adds only 1 missing deployment/i)).toBeTruthy();
    expect(within(dialog).getByText(/materializes exactly 2 current repositories/i)).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Assign Agent One to all current repositories",
      }),
    );
    await waitFor(() =>
      expect(harness.api.addAllCurrentAgentAssignments).toHaveBeenCalledWith(
        "agent-one",
        {
          authorityCeiling: "approval",
          expectedAssignmentEpoch: 7,
          expectedActiveRevisionId: "revision-one",
          materializedRepositoryIds: ["10", "11"],
        },
      ),
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "2 current repositories materialized; 1 missing deployment added",
      }),
    );
  });

  it("refetches stale assignments and maps stable error codes to human copy", async () => {
    harness.api.updateAssignmentState.mockRejectedValue(
      new ApiError("machine text", 409, "assignment_changed"),
    );
    renderDeployments();
    const mobile = await screen.findByTestId("deployment-mobile-list");
    await userEvent.click(within(mobile).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(harness.api.agentAssignments).toHaveBeenCalledTimes(2));
    expect(harness.notify).toHaveBeenCalledWith({
      tone: "error",
      title: "Deployment was not changed",
      description: "The deployment changed. Fresh assignment data has been loaded.",
    });
  });

  it("sends exact authority preconditions for immediate narrowing", async () => {
    renderDeployments();
    const mobile = await screen.findByTestId("deployment-mobile-list");
    await userEvent.click(
      within(mobile).getByLabelText("Authority ceiling for acme/widgets"),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Approval" }));
    await waitFor(() =>
      expect(harness.api.updateAssignmentAuthority).toHaveBeenCalledWith(
        "assignment-secret",
        {
          authorityCeiling: "approval",
          expectedVersion: 3,
          expectedConfigHash: "b".repeat(64),
          expectedAssignmentEpoch: 7,
          reason: null,
        },
      ),
    );
  });

  it("sends exact enable preconditions and reports no-op without success", async () => {
    const disabled = { ...assignment, enabled: false };
    harness.api.agentAssignments.mockResolvedValue({
      assignmentEpoch: 7,
      assignments: [disabled],
    });
    harness.api.updateAssignmentState.mockResolvedValue({
      assignment: disabled,
      assignmentEpoch: 7,
      result: "noop",
    });
    renderDeployments();
    const mobile = await screen.findByTestId("deployment-mobile-list");
    const enable = within(mobile).getByRole("button", { name: "Enable" });
    expect(enable.className).toContain("min-h-11");
    expect(enable.className).toContain("min-w-11");
    await userEvent.click(enable);
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Enable Agent One on acme/widgets" }),
    );
    await waitFor(() =>
      expect(harness.api.updateAssignmentState).toHaveBeenCalledWith(
        "assignment-secret",
        "enable",
        {
          expectedVersion: 3,
          expectedConfigHash: "b".repeat(64),
          expectedAssignmentEpoch: 7,
          expectedActiveRevisionId: "revision-one",
          reason: null,
        },
      ),
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "info", title: "No changes needed" }),
    );
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    );
  });

  it("retries overlap with the exact fresh fingerprint and materialized set", async () => {
    const warning = {
      schemaVersion: "v1" as const,
      assignmentEpoch: 8,
      agent: { id: agent.id, name: agent.name },
      repositories: [
        {
          schemaVersion: "v1" as const,
          assignmentEpoch: 8,
          repositoryId: "11",
          repositoryDisplayName: "acme/tools",
          candidate: {
            agentId: agent.id,
            revisionId: "revision-one",
            revisionCompiledHash: "c".repeat(64),
            assignmentId: "assignment-tools",
            assignmentVersion: 1,
          },
          conflicts: [
            {
              assignmentId: "other-assignment",
              assignmentVersion: 2,
              agentId: "other-agent",
              agentDisplayName: "Other Agent",
              activeRevisionId: "other-revision",
              activeRevisionCompiledHash: "d".repeat(64),
              sharedTriggers: ["github.issue.opened"],
              sharedEffects: ["issue.comment.create"],
            },
          ],
          fingerprint: "inner-fingerprint",
        },
      ],
      preconditions: [
        {
          repositoryId: "11",
          assignmentId: "assignment-tools",
          expectedVersion: null,
          expectedConfigHash: null,
        },
      ],
      materializedRepositoryIds: ["10", "11"],
      fingerprint: "fresh-fingerprint",
      currentActiveRevisionId: "revision-one",
    };
    const secondWarning = {
      ...warning,
      assignmentEpoch: 9,
      fingerprint: "second-fresh-fingerprint",
      repositories: warning.repositories.map((item) => ({
        ...item,
        assignmentEpoch: 9,
        conflicts: item.conflicts.map((conflict) => ({
          ...conflict,
          agentDisplayName: "Fresh Agent",
        })),
      })),
    };
    harness.api.addAllCurrentAgentAssignments
      .mockRejectedValueOnce(
        new ApiError("overlap", 409, "overlap_confirmation_required", {
          error: "overlap_confirmation_required",
          warning,
        }),
      )
      .mockRejectedValueOnce(
        new ApiError("fresh overlap", 409, "overlap_confirmation_required", {
          error: "overlap_confirmation_required",
          warning: secondWarning,
        }),
      )
      .mockResolvedValueOnce({
        assignmentEpoch: 10,
        assignments: [assignment],
        materializedRepositoryCount: 2,
      });
    renderDeployments();
    await userEvent.click(await screen.findByRole("button", { name: "Assign all current" }));
    let dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Assign Agent One to all current repositories",
      }),
    );
    dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Other Agent/)).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Allow Agent One overlap on named repositories",
      }),
    );
    dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText(/Fresh Agent/)).toBeTruthy();
    expect(within(dialog).queryByText(/Other Agent/)).toBeNull();
    expect(harness.api.addAllCurrentAgentAssignments).toHaveBeenCalledTimes(2);
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Allow Agent One overlap on named repositories",
      }),
    );
    await waitFor(() =>
      expect(harness.api.addAllCurrentAgentAssignments).toHaveBeenLastCalledWith(
        "agent-one",
        {
          authorityCeiling: "approval",
          expectedAssignmentEpoch: 9,
          expectedActiveRevisionId: "revision-one",
          materializedRepositoryIds: ["10", "11"],
          overlapFingerprint: "second-fresh-fingerprint",
        },
      ),
    );
    expect(harness.api.addAllCurrentAgentAssignments).toHaveBeenCalledTimes(3);
    expect(harness.api.agentAssignments.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("prevents duplicate guarded confirms while a deployment mutation is pending", async () => {
    let resolveMutation: ((value: unknown) => void) | undefined;
    harness.api.addAllCurrentAgentAssignments.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    renderDeployments();
    await userEvent.click(await screen.findByRole("button", { name: "Assign all current" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Assign Agent One to all current repositories",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(harness.api.addAllCurrentAgentAssignments).toHaveBeenCalledTimes(1),
    );
    resolveMutation?.({
      assignmentEpoch: 8,
      assignments: [assignment],
      materializedRepositoryCount: 2,
    });
  });

  it("does not claim None or expose add controls without current repository state", async () => {
    renderDeployments("owner", false, {
      state: null,
      stateLoading: true,
      error: null,
    });
    expect(await screen.findByText(/Current repository list is loading/)).toBeTruthy();
    expect(screen.queryByText(/^None\./)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assign all current" })).toBeNull();
    const mobile = await screen.findByTestId("deployment-mobile-list");
    expect(within(mobile).getByText("acme/widgets")).toBeTruthy();
  });

  it("separates the desktop table from a complete touch-friendly mobile list", async () => {
    renderDeployments("member");
    const desktop = await screen.findByTestId("deployment-desktop-table");
    const mobile = screen.getByTestId("deployment-mobile-list");

    expect(desktop.className).toContain("hidden");
    expect(desktop.className).toContain("md:block");
    expect(within(desktop).getByRole("table").className).toContain("min-w-[760px]");
    expect(mobile.className).toContain("md:hidden");
    expect(mobile.querySelector('[class*="min-w-[760px]"]')).toBeNull();
    expect(within(mobile).getByText("Status / effective authority")).toBeTruthy();
    expect(within(mobile).getByText("Authority ceiling")).toBeTruthy();
    expect(within(mobile).getByText("Actions")).toBeTruthy();

    const select = within(mobile).getByLabelText("Authority ceiling for acme/widgets");
    expect(select.className).toContain("min-h-11");
    expect(select.className).toContain("min-w-11");
    for (const name of ["Disable", "Remove"]) {
      const control = within(mobile).getByRole("button", { name });
      expect(control.className).toContain("min-h-11");
      expect(control.className).toContain("min-w-11");
    }
  });

  it("has no serious or critical Axe violations at mobile width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    const { container } = renderDeployments();
    const mobile = await screen.findByTestId("deployment-mobile-list");
    expect(within(mobile).getByText("acme/widgets")).toBeTruthy();
    const results = await axe(container);
    expect(
      results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? "")),
    ).toEqual([]);
  });
});
