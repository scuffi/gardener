// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  health: vi.fn(),
  session: vi.fn(),
  state: vi.fn(),
  signOut: vi.fn(),
  syncRepositories: vi.fn(),
  beginInstallation: vi.fn(),
  team: vi.fn(),
  inviteMember: vi.fn(),
  revokeInvitation: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock("./lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/api")>();
  return {
    ...original,
    gardenerApi: api,
  };
});
vi.mock("./providers/notifications", () => ({
  useNotifications: () => ({ notify: vi.fn() }),
}));

import { AppDataProvider, useGardener } from "./app-context";
import { TeamPanel } from "./features/settings/components/team-panel";
import { AccountMenu } from "./shell/account-menu";

function SessionProbe() {
  const { authenticated, session } = useGardener();
  if (!authenticated || !session.authenticated) return <p>Unauthenticated</p>;
  return (
    <p>
      {session.user.displayName} · {session.user.role} · {session.user.identity.provider}
    </p>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppDataProvider session context", () => {
  it("synthesizes a strict local Owner only for local-development bypass", async () => {
    api.health.mockResolvedValue({
      ok: true,
      database: true,
      workersAi: true,
      connectConfigured: false,
      localDevelopment: true,
      agentRuntime: { enabled: true, status: "ready" },
    });
    api.session.mockResolvedValue({ authenticated: false });
    api.state.mockResolvedValue({
      globalPaused: false,
      viewer: { login: "local-developer" },
      setup: { completed: true, activeRepositories: 0 },
      policies: [],
      repositories: [],
    });
    api.team.mockResolvedValue({ members: [], invitations: [] });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AppDataProvider>
            <SessionProbe />
            <AccountMenu />
            <TeamPanel />
          </AppDataProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Local developer · owner · local")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open account menu for local-developer" }),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Invite GitHub user" })).toBeTruthy();
  });

  it("does not synthesize a production session", async () => {
    api.health.mockResolvedValue({
      ok: true,
      database: true,
      workersAi: true,
      connectConfigured: true,
      localDevelopment: false,
      agentRuntime: { enabled: true, status: "ready" },
    });
    api.session.mockResolvedValue({ authenticated: false });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AppDataProvider>
            <SessionProbe />
          </AppDataProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Unauthenticated")).toBeTruthy();
    expect(api.state).not.toHaveBeenCalled();
  });
});
