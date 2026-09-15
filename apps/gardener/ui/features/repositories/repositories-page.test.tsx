// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryPolicyView, WorkspaceRole } from "../../lib/types";
import {
  observationCapabilities,
  operationKinds,
  workspaceCapabilities,
} from "./constants";

const harness = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  api: {
    beginInstallation: vi.fn(),
    syncRepositories: vi.fn(),
    setRepositoryPaused: vi.fn(),
    repositoryAssignments: vi.fn(),
    repositoryPolicy: vi.fn(),
    setRepositoryPolicy: vi.fn(),
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

import { RepositoriesPage } from "./repositories-page";

const repository = {
  id: "repo-internal-42",
  owner: "cloudflare",
  name: "workers-sdk",
  active: 1 as const,
  paused: true,
};

function policy(configured: boolean): RepositoryPolicyView {
  const operationModes = Object.fromEntries(operationKinds.map((key) => [key, "disabled"]));
  const workspaceModes = Object.fromEntries(workspaceCapabilities.map((key) => [key, "disabled"]));
  return {
    configured,
    message: configured ? undefined : "Policy not configured — nothing will run",
    repository: { id: repository.id, name: "cloudflare/workers-sdk", active: true },
    policy: {
      schemaVersion: "v1",
      repositoryId: repository.id,
      repositoryDisplayName: "cloudflare/workers-sdk",
      version: 1,
      policyHash: "a".repeat(64),
      operationModes,
      allowedObservations: [],
      workspaceModes,
    },
    policyVersion: 7,
    policyHash: "a".repeat(64),
    repositoryConstraints: {},
    workspaceCeilings: {
      operationModes: Object.fromEntries(operationKinds.map((key) => [key, "automatic"])),
      observation: Object.fromEntries(observationCapabilities.map((key) => [key, "automatic"])),
      workspaceModes: Object.fromEntries(workspaceCapabilities.map((key) => [key, "automatic"])),
      constraints: {},
    },
    effective: { operationModes, allowedObservations: [], workspaceModes },
  } as RepositoryPolicyView;
}

function context(role: WorkspaceRole) {
  return {
    state: {
      globalPaused: false,
      viewer: { login: "viewer" },
      setup: { completed: true, activeRepositories: 1 },
      policies: [],
      repositories: [repository],
    },
    stateLoading: false,
    error: null,
    refresh: vi.fn(),
    session: {
      authenticated: true,
      githubLogin: "viewer",
      user: {
        id: "user-1",
        displayName: "Human Viewer",
        role,
        identity: { provider: "github", providerSubject: "1", login: "viewer" },
      },
    },
  };
}

function renderPage(role: WorkspaceRole = "owner") {
  harness.context = context(role);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RepositoriesPage />
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

beforeEach(() => {
  vi.clearAllMocks();
  harness.api.repositoryAssignments.mockResolvedValue({
    assignmentEpoch: 3,
    assignments: [
      {
        schemaVersion: "v1",
        id: "assignment-secret-id",
        version: 1,
        configHash: "b".repeat(64),
        agentId: "agent-secret-id",
        agentDisplayName: "Issue gardener",
        repositoryId: repository.id,
        repositoryDisplayName: "cloudflare/workers-sdk",
        enabled: true,
        authorityCeiling: "approval",
        createdAt: "2026-09-15T00:00:00Z",
        updatedAt: "2026-09-15T00:00:00Z",
        removedAt: null,
      },
      {
        schemaVersion: "v1",
        id: "removed-assignment-one",
        version: 2,
        configHash: "c".repeat(64),
        agentId: "removed-agent-one",
        agentDisplayName: "Retired reviewer",
        repositoryId: repository.id,
        repositoryDisplayName: "cloudflare/workers-sdk",
        enabled: false,
        authorityCeiling: "disabled",
        createdAt: "2026-09-14T00:00:00Z",
        updatedAt: "2026-09-15T00:00:00Z",
        removedAt: "2026-09-15T01:00:00Z",
      },
      {
        schemaVersion: "v1",
        id: "removed-assignment-two",
        version: 3,
        configHash: "d".repeat(64),
        agentId: "removed-agent-two",
        agentDisplayName: "Legacy labeler",
        repositoryId: repository.id,
        repositoryDisplayName: "cloudflare/workers-sdk",
        enabled: false,
        authorityCeiling: "approval",
        createdAt: "2026-09-13T00:00:00Z",
        updatedAt: "2026-09-15T00:00:00Z",
        removedAt: "2026-09-15T02:00:00Z",
      },
    ],
  });
  harness.api.repositoryPolicy.mockResolvedValue(policy(false));
  harness.api.setRepositoryPolicy.mockResolvedValue({ result: "updated", policy: policy(true) });
  harness.api.setRepositoryPaused.mockResolvedValue({ id: repository.id, paused: false });
});

afterEach(cleanup);

describe("repository-centric authority", () => {
  it("shows human assignment names, count, status, native full-row link, and no primary raw IDs", async () => {
    renderPage();
    const details = await screen.findByRole("button", { name: /1 assigned Agent/ });
    await userEvent.click(details);
    const link = await screen.findByRole("link", { name: /Issue gardener, enabled, view Agent/ });
    expect(link.getAttribute("href")).toBe("/agents/agent-secret-id");
    expect(within(link).getByText("Issue gardener")).toBeTruthy();
    expect(within(link).getByText("Enabled")).toBeTruthy();
    const retired = screen.getByRole("link", { name: /Retired reviewer, access removed, view Agent/ });
    const legacy = screen.getByRole("link", { name: /Legacy labeler, access removed, view Agent/ });
    expect(within(retired).getByText("Removed")).toBeTruthy();
    expect(within(legacy).getByText("Removed")).toBeTruthy();
    expect(screen.queryByText("3 assigned Agents")).toBeNull();
    expect(screen.queryByText("assignment-secret-id")).toBeNull();
    expect(screen.queryByText("repo-internal-42")).toBeNull();
  });

  it("uses contained equal tracks that stack safely at post-sidebar desktop widths", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /1 assigned Agent/ }));

    const layout = screen.getByTestId("repository-detail-layout");
    expect(layout.className).toContain("min-w-0");
    expect(layout.className).toContain("grid-cols-1");
    expect(layout.className).toContain("2xl:grid-cols-2");

    const assignments = screen.getByRole("region", { name: "Assigned Agents" });
    const policySection = screen.getByRole("region", { name: "Repository policy" });
    expect(assignments.className).toContain("min-w-0");
    expect(policySection.className).toContain("min-w-0");
    expect(within(assignments).getByRole("link", { name: /Issue gardener/ }).className)
      .toContain("max-sm:flex-col");
  });

  it("configures a missing policy only for owners with an exhaustive disabled body", async () => {
    renderPage();
    await userEvent.click(await screen.findByText("View details"));
    expect(await screen.findByText("Policy not configured — nothing will run")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Configure complete disabled policy" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Configure complete disabled policy" }),
    );
    await waitFor(() => expect(harness.api.setRepositoryPolicy).toHaveBeenCalledTimes(1));
    const [, body] = harness.api.setRepositoryPolicy.mock.calls[0]!;
    expect(body.expectedPolicyVersion).toBe(7);
    expect(body.expectedPolicyHash).toBeNull();
    expect(Object.keys(body.operationModes)).toHaveLength(29);
    expect(Object.values(body.operationModes)).toEqual(Array(29).fill("disabled"));
    expect(body.allowedObservations).toEqual([]);
    expect(Object.keys(body.workspaceModes)).toHaveLength(10);
    expect(Object.values(body.workspaceModes)).toEqual(Array(10).fill("disabled"));
  });

  it("gates owner-only sync, installation, resume, and configuration while members may pause", async () => {
    const user = userEvent.setup();
    renderPage("member");
    await user.click(await screen.findByText("View details"));
    expect(screen.queryByRole("button", { name: "Sync access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage GitHub installation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure complete disabled policy" })).toBeNull();

    cleanup();
    harness.context = {
      ...context("member"),
      state: { ...context("member").state, repositories: [{ ...repository, paused: false }] },
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><RepositoriesPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByText("View details"));
    await user.click(screen.getByRole("button", { name: "Pause repository" }));
    await waitFor(() => expect(harness.api.setRepositoryPaused).toHaveBeenCalledWith(repository.id, true));
  });

  it("stacks expanded details without clipping and passes Axe at mobile width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    const { container } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /1 assigned Agent/ }));

    const layout = screen.getByTestId("repository-detail-layout");
    expect(layout.className).toContain("grid-cols-1");
    expect(screen.getByRole("link", { name: /Issue gardener/ }).className)
      .toContain("max-sm:items-start");
    for (const name of [
      "Resume repository",
      "Manage GitHub installation",
      "Configure complete disabled policy",
    ]) {
      expect(screen.getByRole("button", { name }).className).toContain("max-sm:min-h-11");
    }

    const results = await axe(container);
    expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? "")))
      .toEqual([]);
  });
});
