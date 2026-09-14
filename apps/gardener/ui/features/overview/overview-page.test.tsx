// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../../lib/types";

/**
 * Render smoke tests for Overview.
 *
 * Typechecking proves the props line up; it does not prove the page mounts. These tests execute
 * the real component tree so a composition error surfaces here rather than in the browser.
 */

const context = vi.hoisted(() => ({
  value: {
    state: null as unknown,
    health: null as unknown,
    error: null as Error | null,
    refresh: vi.fn(async () => undefined),
  },
}));

vi.mock("../../app-context", () => ({ useGardener: () => context.value }));

import { OverviewPage } from "./overview-page";

const iso = (offsetMs: number) =>
  new Date(Date.now() - offsetMs).toISOString().replace("T", " ").replace("Z", "");

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "run_0123456789abcdef",
  kind: "issue.triage",
  agent_id: "agent_1",
  status: "completed",
  created_at: iso(60_000),
  started_at: iso(60_000),
  completed_at: iso(30_000),
  ...over,
});

const healthy = {
  ok: true,
  database: true,
  workersAi: true,
  connectConfigured: true,
  localDevelopment: false,
  agentRuntime: { enabled: true, status: "ready" },
};

const baseState = {
  globalPaused: false,
  viewer: { login: "octocat" },
  setup: { completed: true, profile: "balanced", activeRepositories: 1 },
  policies: [{ operation_kind: "issue.comment.create", mode: "auto" }],
  repositories: [{ id: "1", owner: "cf", name: "gardener", active: 1, paused: false }],
  inboxCount: 0,
  runs: [run()],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  context.value.state = baseState;
  context.value.health = healthy;
  context.value.error = null;
});

describe("Overview", () => {
  it("renders the stat strip and recent runs from real state", () => {
    context.value.state = baseState;
    context.value.health = healthy;
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(screen.getByText("Runs, last 24 hours")).toBeTruthy();
    expect(screen.getByText("Recent runs")).toBeTruthy();
    // The run id is shortened but still rendered.
    expect(screen.getByText("run_01234567")).toBeTruthy();
  });

  it("reports a calm state when nothing needs attention", () => {
    context.value.state = baseState;
    context.value.health = healthy;
    renderPage();

    expect(screen.getByText("Fleet is ready")).toBeTruthy();
    expect(screen.getByText("Inbox is clear")).toBeTruthy();
  });

  it("surfaces real problems instead of inventing them", () => {
    context.value.state = {
      ...baseState,
      globalPaused: true,
      runs: [run({ id: "run_bad", status: "failed" })],
    };
    context.value.health = { ...healthy, ok: false, database: false };
    renderPage();

    expect(screen.getByText("Fleet is globally paused")).toBeTruthy();
    expect(screen.getByText(/service is unavailable/)).toBeTruthy();
    expect(screen.getByText(/run needs review/)).toBeTruthy();
    expect(screen.queryByText("Fleet is ready")).toBeNull();
  });

  it("shows a skeleton rather than a blank screen while state loads", () => {
    context.value.state = null;
    context.value.health = null;
    const { container } = renderPage();

    expect(screen.getByRole("status", { name: "Loading overview" })).toBeTruthy();
    expect(container.textContent).not.toContain("Overview");
  });

  it("offers a retry when the deployment cannot be loaded", () => {
    context.value.state = null;
    context.value.health = null;
    context.value.error = new Error("boom");
    renderPage();

    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("guides a brand new install with no runs", () => {
    context.value.state = { ...baseState, runs: [] };
    context.value.health = healthy;
    renderPage();

    expect(screen.getByText("No runs yet")).toBeTruthy();
  });
});
