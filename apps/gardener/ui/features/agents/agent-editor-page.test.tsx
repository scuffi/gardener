// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  api: {
    agent: vi.fn(),
    createAgent: vi.fn(),
    saveAgentDraft: vi.fn(),
    validateAgent: vi.fn(),
    simulateAgent: vi.fn(),
    publishAgent: vi.fn(),
  },
  notify: vi.fn(),
}));

vi.mock("../../lib/api", async (original) => {
  const actual = await original<typeof import("../../lib/api")>();
  return { ...actual, gardenerApi: harness.api };
});
vi.mock("../../providers/notifications", () => ({
  useNotifications: () => ({ notify: harness.notify }),
}));

import { AgentEditorPage } from "./agent-editor-page";

function renderEditor(path = "/agents/new") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/agents/new" element={<AgentEditorPage />} />
          <Route path="/agents/:id/draft" element={<AgentEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("repository-independent Agent editor", () => {
  it("generates repository-free source and sends no repository context", async () => {
    harness.api.createAgent.mockResolvedValue({
      agent: { id: "agent-one" },
      draftId: "draft-one",
    });
    renderEditor();

    const source = screen.getByRole("textbox", { name: "Agent package source" });
    expect((source as HTMLTextAreaElement).value).not.toContain("repositories:");
    expect(screen.queryByLabelText("Repository context")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(harness.api.createAgent).toHaveBeenCalledTimes(1));
    expect(harness.api.createAgent.mock.calls[0]).toHaveLength(1);
    expect(harness.api.createAgent.mock.calls[0]![0]).not.toContain("repositories:");
  });

  it("validates and publishes without a repository argument", async () => {
    harness.api.validateAgent.mockResolvedValue({
      valid: true,
      publishable: true,
      diagnostics: [],
      capabilities: { observation: [], workspace: [], effects: [] },
    });
    harness.api.createAgent.mockResolvedValue({
      agent: { id: "agent-one" },
      draftId: "draft-one",
    });
    harness.api.publishAgent.mockResolvedValue({ revision: 1, paused: true });
    renderEditor();

    await userEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText("Valid Agent source")).toBeTruthy();
    expect(harness.api.validateAgent.mock.calls[0]).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Publish paused" }));
    await waitFor(() => expect(harness.api.publishAgent).toHaveBeenCalledTimes(1));
    expect(harness.api.publishAgent.mock.calls[0]).toHaveLength(2);
  });
});
