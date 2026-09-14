import type { ReactNode } from "react";
import { Button, Dialog } from "./kumo";

/**
 * Confirmation for an action that widens authority or destroys something.
 *
 * `confirmLabel` must name the exact operation being authorised — never "OK" or "Confirm". The
 * operator should be able to read the button and know precisely what will happen.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  detail,
  confirmLabel,
  confirmTone = "primary",
  loading = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  detail?: ReactNode;
  confirmLabel: string;
  confirmTone?: "primary" | "destructive";
  loading?: boolean;
  onConfirm: () => unknown | Promise<unknown>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
      <Dialog size="base" className="p-5">
        <Dialog.Title className="text-lg font-semibold text-kumo-strong">{title}</Dialog.Title>
        <Dialog.Description className="mt-2 leading-relaxed text-kumo-subtle">
          {description}
        </Dialog.Description>
        {detail ? (
          <div className="mt-3.5 rounded-md border border-kumo-hairline bg-kumo-recessed px-3 py-2.5">
            {detail}
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2 max-sm:flex-col-reverse">
          <Dialog.Close render={<Button variant="secondary">Cancel</Button>} />
          <Button
            variant={confirmTone}
            loading={loading}
            disabled={loading}
            onClick={() => {
              // Mutations report failures through their own notification callbacks. Catch the
              // rejected promise here so a handled API failure does not become an unhandled one.
              void Promise.resolve().then(onConfirm).catch(() => undefined);
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
