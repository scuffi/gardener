// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  value: {
    health: { connectConfigured: true, localDevelopment: false } as { connectConfigured: boolean; localDevelopment: boolean } | null,
    loading: false,
    error: null as Error | null,
    refresh: vi.fn(async () => undefined),
  },
}));

vi.mock("../app-context", () => ({ useGardener: () => context.value }));
vi.mock("../theme", () => ({ ThemeToggle: () => <button type="button" aria-label="Switch theme">Theme</button> }));
vi.mock("./ascii-garden", () => ({ AsciiGarden: () => <div className="signin-garden" aria-hidden="true" /> }));

import { SignInPage } from "./sign-in-page";

afterEach(() => {
  cleanup();
  context.value.health = { connectConfigured: true, localDevelopment: false };
  context.value.loading = false;
  context.value.error = null;
});

describe("Gardener sign-in", () => {
  it("presents one focused owner sign-in without dashboard navigation", () => {
    const { container } = render(<SignInPage />);
    const heading = screen.getByRole("heading", { level: 1, name: "Welcome back" });
    const button = screen.getByRole("button", { name: "Sign in with GitHub" });

    expect(heading.id).toBe("signin-heading");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-describedby")).toContain("signin-owner-note");
    expect(screen.getByText(/Repository access is managed separately through Gardener Connect/)).toBeTruthy();
    expect(container.querySelector(".gardener-sidebar")).toBeNull();
    expect(container.querySelector(".signin-garden")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses the same standalone experience while checking or recovering the deployment", () => {
    context.value.loading = true;
    const { container, rerender } = render(<SignInPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Opening Gardener" })).toBeTruthy();
    expect(container.querySelector(".gardener-sidebar")).toBeNull();

    context.value.loading = false;
    context.value.health = null;
    context.value.error = new Error("Synthetic connection failure");
    rerender(<SignInPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Unable to reach Gardener" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Synthetic connection failure");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps the sign-in action disabled when the deployment is not configured", () => {
    context.value.health = { connectConfigured: false, localDevelopment: false };
    render(<SignInPage />);

    expect(screen.getByText("Dashboard sign-in is not configured")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" }).hasAttribute("disabled")).toBe(true);
  });
});
