// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../../lib/query-keys";

const harness = vi.hoisted(() => ({
  role: "owner" as "owner" | "member",
  notify: vi.fn(),
  team: vi.fn(),
  inviteMember: vi.fn(),
  revokeInvitation: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock("../../../app-context", () => ({
  useGardener: () => ({
    session: {
      authenticated: true,
      githubLogin: "owner",
      user: {
        id: "owner-id",
        displayName: "Owner Name",
        role: harness.role,
        identity: { provider: "github", providerSubject: "1", login: "owner" },
      },
    },
  }),
}));
vi.mock("../../../lib/api", () => ({
  gardenerApi: {
    team: harness.team,
    inviteMember: harness.inviteMember,
    revokeInvitation: harness.revokeInvitation,
    removeMember: harness.removeMember,
  },
}));
vi.mock("../../../providers/notifications", () => ({
  useNotifications: () => ({ notify: harness.notify }),
}));

import { TeamPanel } from "./team-panel";

const loadedTeam = {
  members: [
    {
      id: "opaque-owner-id",
      display_name: "Owner Name",
      role: "owner",
      permanent: 1,
      username: "owner-login",
      provider_subject: "101",
    },
    {
      id: "opaque-member-id",
      display_name: "Member Name",
      role: "member",
      permanent: 0,
      username: "member-login",
      provider_subject: "202",
    },
  ],
  invitations: [
    {
      id: "opaque-invitation-id",
      username: "future-member",
      provider_subject: "303",
      created_at: "2026-09-15 09:00:00",
      expires_at: "2026-09-29 09:00:00",
    },
  ],
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <TeamPanel />
    </QueryClientProvider>,
  );
  return { ...view, invalidate };
}

afterEach(() => {
  cleanup();
  harness.role = "owner";
  harness.notify.mockReset();
  harness.team.mockReset();
  harness.inviteMember.mockReset();
  harness.revokeInvitation.mockReset();
  harness.removeMember.mockReset();
});

describe("Team settings", () => {
  it("renders loading and error states without management controls", async () => {
    harness.team.mockReturnValueOnce(new Promise(() => undefined));
    const loading = renderPanel();
    expect(screen.getByRole("status", { name: "Loading team" })).toBeTruthy();
    loading.unmount();

    harness.team.mockRejectedValueOnce(new Error("Team unavailable"));
    renderPanel();
    expect(await screen.findByText("Team unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite GitHub user" })).toBeNull();
    cleanup();

  });

  it("keeps the owner invitation form available in an otherwise empty state", async () => {
    harness.team.mockResolvedValueOnce({ members: [], invitations: [] });
    renderPanel();
    expect(await screen.findByText("No team members reported")).toBeTruthy();
    expect(screen.getByLabelText("GitHub username")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite GitHub user" })).toBeTruthy();
  });

  it("shows human identities and leaves members strictly read-only", async () => {
    harness.role = "member";
    harness.team.mockResolvedValue(loadedTeam);
    const { container } = renderPanel();

    expect(await screen.findByText("Owner Name")).toBeTruthy();
    expect(screen.getByText("@owner-login")).toBeTruthy();
    expect(screen.getByText("Member Name")).toBeTruthy();
    expect(screen.getByText("@future-member")).toBeTruthy();
    expect(screen.getByText(/Expires/)).toBeTruthy();
    expect(container.textContent).not.toContain("opaque-");
    expect(screen.queryByRole("button", { name: "Invite GitHub user" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();

    const results = await axe(container);
    expect(results.violations.filter((violation) => violation.impact === "serious")).toHaveLength(0);
    expect(results.violations.filter((violation) => violation.impact === "critical")).toHaveLength(0);
  });

  it("validates GitHub usernames before inviting", async () => {
    harness.team.mockResolvedValue(loadedTeam);
    renderPanel();

    fireEvent.change(await screen.findByLabelText("GitHub username"), {
      target: { value: "bad--login" },
    });
    expect(screen.getByText(/Enter a valid GitHub username/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite GitHub user" }).hasAttribute("disabled")).toBe(true);
    expect(harness.inviteMember).not.toHaveBeenCalled();
  });

  it("invites by GitHub username, invalidates the team cache, and notifies", async () => {
    harness.team.mockResolvedValue(loadedTeam);
    harness.inviteMember.mockResolvedValue({
      invitation: { id: "invitation-id", githubUsername: "new-login", role: "member" },
    });
    const { invalidate } = renderPanel();

    fireEvent.change(await screen.findByLabelText("GitHub username"), {
      target: { value: "new-login" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite GitHub user" }));

    await waitFor(() => expect(harness.inviteMember).toHaveBeenCalled());
    expect(harness.inviteMember.mock.calls[0]?.[0]).toBe("new-login");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.team });
    expect(harness.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Invitation sent to @new-login" }),
    );
  });

  it("uses exact human confirmations for revocation and removal", async () => {
    harness.team.mockResolvedValue(loadedTeam);
    harness.revokeInvitation.mockResolvedValue({ revoked: true });
    harness.removeMember.mockResolvedValue({ removed: true });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke @future-member" }));
    expect(screen.getByText("Revoke the invitation for @future-member?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke invitation for @future-member" }));
    await waitFor(() => expect(harness.revokeInvitation).toHaveBeenCalled());
    expect(harness.revokeInvitation.mock.calls[0]?.[0]).toBe("opaque-invitation-id");

    fireEvent.click(screen.getByRole("button", { name: "Remove @member-login" }));
    expect(screen.getByText("Remove @member-login from the team?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove @member-login" }));
    await waitFor(() => expect(harness.removeMember).toHaveBeenCalled());
    expect(harness.removeMember.mock.calls[0]?.[0]).toBe("opaque-member-id");
    expect(screen.queryByRole("button", { name: "Remove @owner-login" })).toBeNull();
  });

  it("keeps exact destructive copy through Escape closing and rejects a stale click", async () => {
    const unfinishedAnimation = new Promise<void>(() => undefined);
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [{ finished: unfinishedAnimation }],
    });
    harness.team.mockResolvedValue(loadedTeam);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Remove @member-login" }));
    const dialog = screen.getByRole("alertdialog");
    const staleConfirm = within(dialog).getByRole("button", { name: "Remove @member-login" });

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });

    expect(staleConfirm.isConnected).toBe(true);
    expect(document.body.textContent).toContain("Remove @member-login from the team?");
    expect(document.body.textContent).toContain("Remove @member-login");
    fireEvent.click(staleConfirm);
    expect(harness.removeMember).not.toHaveBeenCalled();
    expect(harness.revokeInvitation).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
  });

  it("keeps a failed destructive confirmation and persistent error visible", async () => {
    harness.team.mockResolvedValue(loadedTeam);
    harness.removeMember.mockRejectedValue(new Error("Removal was rejected"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Remove @member-login" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove @member-login" }));

    expect(await screen.findByText("Removal was rejected")).toBeTruthy();
    expect(screen.getByText("Remove @member-login from the team?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove @member-login" })).toBeTruthy();
    expect(harness.notify).toHaveBeenCalledWith({
      tone: "error",
      title: "Could not remove @member-login",
      description: "Removal was rejected",
    });
  });

  it("keeps a failed revocation open and reports it through persistent feedback", async () => {
    harness.team.mockResolvedValue(loadedTeam);
    harness.revokeInvitation.mockRejectedValue(new Error("Revocation was rejected"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke @future-member" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke invitation for @future-member" }));

    expect(await screen.findByText("Revocation was rejected")).toBeTruthy();
    expect(screen.getByText("Revoke the invitation for @future-member?")).toBeTruthy();
    expect(harness.notify).toHaveBeenCalledWith({
      tone: "error",
      title: "Could not revoke the invitation for @future-member",
      description: "Revocation was rejected",
    });
  });

  it("reports invite failures and clears the stale error on the next attempt", async () => {
    harness.team.mockResolvedValue(loadedTeam);
    harness.inviteMember
      .mockRejectedValueOnce(new Error("Invitation was rejected"))
      .mockResolvedValueOnce({
        invitation: { id: "new-invitation", githubUsername: "new-login", role: "member" },
      });
    renderPanel();
    const input = await screen.findByLabelText("GitHub username");

    fireEvent.change(input, { target: { value: "new-login" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite GitHub user" }));
    expect(await screen.findByText("Invitation was rejected")).toBeTruthy();
    expect(harness.notify).toHaveBeenCalledWith({
      tone: "error",
      title: "Invitation failed",
      description: "Invitation was rejected",
    });

    fireEvent.click(screen.getByRole("button", { name: "Invite GitHub user" }));
    await waitFor(() => expect(harness.inviteMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Invitation was rejected")).toBeNull());
  });
});
