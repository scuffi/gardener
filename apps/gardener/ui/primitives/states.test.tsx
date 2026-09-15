// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorState } from "./states";

afterEach(cleanup);

describe("ErrorState", () => {
  it("gives the shared mobile retry action a 44px minimum touch target", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Request failed" onRetry={onRetry} />);

    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.className).toContain("max-[900px]:min-h-11");
    expect(retry.className).toContain("max-[900px]:min-w-11");
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
