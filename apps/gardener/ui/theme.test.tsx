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
});

describe("signature green", () => {
  it("ignores retired accent preferences", async () => {
    localStorage.setItem("gardener.accent.v2", "orange");
    render(
      <ThemeProvider>
        <p>Dashboard</p>
      </ThemeProvider>,
    );

    expect(screen.getByText("Dashboard")).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.mode).toBe("light"));
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });
});
