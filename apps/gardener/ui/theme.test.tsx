// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ThemeProvider } from "./theme";

beforeAll(() => {
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.accent;
});

describe("brand accent", () => {
  it("starts new and migrated sessions with Gardener green", async () => {
    localStorage.setItem("gardener.accent", "orange");
    render(
      <ThemeProvider>
        <p>Dashboard</p>
      </ThemeProvider>,
    );

    expect(screen.getByText("Dashboard")).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.accent).toBe("green"));
    expect(localStorage.getItem("gardener.accent.v2")).toBe("green");
  });
});
