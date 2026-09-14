// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolicyMode } from "../../../lib/types";
import { PolicyRow } from "./policy-row";

const modeCopy: Record<PolicyMode, { label: string; description: string }> = {
  disabled: { label: "Disabled", description: "Gardener cannot execute this operation." },
  approval: { label: "Require approval", description: "A person must approve every proposal." },
  automatic: { label: "Automatic", description: "Valid proposals may execute without review." },
};

const selectedTint: Record<PolicyMode, string> = {
  disabled: "has-[[data-checked]]:!bg-(--color-gardener-policy-disabled-surface)",
  approval: "has-[[data-checked]]:!bg-(--color-gardener-policy-approval-surface)",
  automatic: "has-[[data-checked]]:!bg-(--color-gardener-policy-automatic-surface)",
};

afterEach(cleanup);

describe("PolicyRow", () => {
  it.each<PolicyMode>(["disabled", "approval", "automatic"])(
    "uses the muted semantic tint for %s",
    (mode) => {
      render(
        <PolicyRow
          policy={{ operation_kind: "issue.comment.create", mode }}
          value={mode}
          metadata={{ name: "Create issue comments", description: "Add a comment to an issue." }}
          modeCopy={modeCopy}
          onChange={vi.fn()}
        />,
      );

      const selected = screen.getByRole("radio", { name: modeCopy[mode].label });
      const card = selected.closest("label");

      expect(selected.getAttribute("aria-checked")).toBe("true");
      expect(card?.className).toContain(selectedTint[mode]);
    },
  );
});
