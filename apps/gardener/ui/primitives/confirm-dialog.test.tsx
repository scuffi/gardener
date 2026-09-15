// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("keeps long exact action labels and Cancel discoverable within the viewport", () => {
    const confirmLabel =
      "Assign issue triage and contributor support to every current repository including a very long name";
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Assign this Agent?"
        description="The current repository set is materialized now."
        confirmLabel={confirmLabel}
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: confirmLabel });
    const footer = cancel.parentElement;

    expect(dialog.className).toContain("max-w-[calc(100vw-2rem)]");
    expect(footer?.className).toContain("flex-wrap");
    expect(footer?.className).toContain("max-sm:flex-col-reverse");
    expect(cancel.className).toContain("max-sm:min-h-11");
    expect(cancel.className).toContain("max-sm:w-full");
    expect(confirm.className).toContain("whitespace-normal");
    expect(confirm.className).toContain("break-words");
    expect(confirm.className).toContain("max-sm:min-h-11");
    expect(confirm.className).toContain("max-sm:w-full");
  });

  it("fails closed while loading", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Remove member?"
        description="Access will be removed."
        confirmLabel="Remove @member"
        loading
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByText("Remove @member").closest("button");
    expect(confirm).not.toBeNull();
    expect(confirm?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm as HTMLButtonElement);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
