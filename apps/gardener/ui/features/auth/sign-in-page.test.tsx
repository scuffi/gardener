// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// jsdom implements neither matchMedia nor ResizeObserver. The ascii garden needs both: it
// queries reduced-motion and fine-pointer support, and observes its own box to pick a glyph
// grid. Stub them rather than mocking the garden away, because the point of these tests is that
// the real decoration renders and stays invisible to assistive technology.
beforeAll(() => {
  const globals = window as unknown as Record<string, unknown>;
  if (typeof globals.ResizeObserver !== "function") {
    globals.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof window.matchMedia === "function") return;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const context = vi.hoisted(() => ({
  value: {
    health: { githubGateway: { configured: true, ready: true }, localDevelopment: false } as {
      githubGateway: { configured: boolean; ready: boolean };
      localDevelopment: boolean;
    } | null,
    loading: false,
    error: null as Error | null,
    refresh: vi.fn(async () => undefined),
  },
}));

vi.mock("../../app-context", () => ({ useGardener: () => context.value }));
vi.mock("../../theme", () => ({
  ThemeToggle: () => (
    <button type="button" aria-label="Switch theme">
      Theme
    </button>
  ),
}));

import { SignInPage } from "./sign-in-page";

afterEach(() => {
  cleanup();
  context.value.health = {
    githubGateway: { configured: true, ready: true },
    localDevelopment: false,
  };
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
    expect(screen.getByText(/Repository access is managed by your customer-owned GitHub Gateway/)).toBeTruthy();
    expect(screen.getByText("Customer-deployed on Cloudflare Workers")).toBeTruthy();
    expect(screen.queryByText(/Powered by Cloudflare/i)).toBeNull();
    expect(container.querySelector(".gardener-sidebar")).toBeNull();
  });

  it("renders the ascii garden as decoration that assistive technology ignores", () => {
    const { container } = render(<SignInPage />);
    const garden = container.querySelector(".signin-garden");
    const horizon = container.querySelector(".signin-horizon");

    expect(garden).toBeTruthy();
    expect(horizon).toBeTruthy();
    expect(garden?.getAttribute("aria-hidden")).toBe("true");
    expect(horizon?.getAttribute("aria-hidden")).toBe("true");
    // Six stacked <pre> layers: far, near, and four bloom hues.
    expect(container.querySelectorAll(".signin-garden__layer").length).toBe(6);
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
    context.value.health = {
      githubGateway: { configured: false, ready: false },
      localDevelopment: false,
    };
    render(<SignInPage />);

    expect(screen.getByText("Dashboard sign-in is not configured")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" }).hasAttribute("disabled")).toBe(true);
  });
});
