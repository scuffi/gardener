// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./kumo", () => ({
  Badge: ({
    variant,
    appearance,
    children,
  }: {
    variant: string;
    appearance: string;
    children: ReactNode;
  }) => (
    <span data-badge-variant={variant} data-badge-appearance={appearance}>
      {children}
    </span>
  ),
}));

import { StatusBadge, type StatusTone } from "./status-badge";

afterEach(cleanup);

describe("StatusBadge", () => {
  it("uses only Kumo-supported dot variants for every status tone", () => {
    const tones: StatusTone[] = ["success", "warning", "danger", "info", "neutral"];
    const { container } = render(
      <>
        {tones.map((tone) => (
          <StatusBadge key={tone} tone={tone}>
            {tone}
          </StatusBadge>
        ))}
      </>,
    );

    const badges = [...container.querySelectorAll<HTMLElement>("[data-badge-variant]")];
    expect(badges.map((badge) => badge.dataset.badgeVariant)).toEqual([
      "success",
      "warning",
      "error",
      "neutral",
      "neutral",
    ]);
    expect(
      badges
        .filter((badge) => badge.dataset.badgeAppearance === "dot")
        .every((badge) => ["success", "warning", "error", "neutral"].includes(
          badge.dataset.badgeVariant ?? "",
        )),
    ).toBe(true);
  });

  it("identifies the neutral-mapped info tone accessibly", () => {
    const { container } = render(<StatusBadge tone="info">Observing</StatusBadge>);
    expect(container.textContent).toBe("Informational status: Observing");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Informational status: ");
  });
});
