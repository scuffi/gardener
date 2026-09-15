// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  role: "owner" as "owner" | "member",
  authenticated: true,
  signOut: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../app-context", () => ({
  useGardener: () => ({
    state: {
      viewer: { login: "legacy-login" },
      repositories: [{ id: "10", owner: "acme", name: "widgets", active: 1 }],
    },
    session: harness.authenticated
      ? {
          authenticated: true,
          githubLogin: "human-login",
          user: {
            id: "raw-user-id",
            displayName: "Human Name",
            role: harness.role,
            identity: {
              provider: "github",
              providerSubject: "raw-provider-id",
              login: "human-login",
            },
          },
        }
      : { authenticated: false },
    signOut: harness.signOut,
  }),
}));
vi.mock("../providers/notifications", () => ({
  useNotifications: () => ({ notify: harness.notify }),
}));

import { AccountMenu } from "./account-menu";

function renderMenu() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AccountMenu />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  harness.role = "owner";
  harness.authenticated = true;
  harness.signOut.mockReset();
  harness.notify.mockReset();
});

describe("Account menu", () => {
  it("shows the human identity and Owner role without raw IDs", async () => {
    const { container } = renderMenu();
    const trigger = screen.getByRole("button", { name: "Open account menu for human-login" });
    expect(trigger.className).toContain("max-[900px]:min-h-11");
    expect(trigger.className).toContain("max-[900px]:min-w-11");
    expect(screen.getByText("Human Name")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();

    fireEvent.click(trigger);
    expect(await screen.findByText("@human-login · Owner")).toBeTruthy();
    expect(screen.getByText("Manage GitHub access")).toBeTruthy();
    expect(container.textContent).not.toContain("raw-user-id");
    expect(container.textContent).not.toContain("raw-provider-id");
  });

  it("shows Member and hides owner-only GitHub management", async () => {
    harness.role = "member";
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Open account menu for human-login" }));

    expect(await screen.findByText("@human-login · Member")).toBeTruthy();
    expect(screen.queryByText("Manage GitHub access")).toBeNull();
    expect(screen.getByText("Dashboard settings")).toBeTruthy();
    expect(screen.getByText("Sign out")).toBeTruthy();
  });

  it("renders no account UI for an unauthenticated session", () => {
    harness.authenticated = false;
    const { container } = renderMenu();
    expect(container.textContent).toBe("");
  });
});
