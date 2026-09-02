import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import type { ReactNode } from "react";

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
  return <Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
    <Dialog size="base" className="confirm-dialog">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
      {detail ? <div className="confirm-dialog__detail">{detail}</div> : null}
      <div className="confirm-dialog__actions">
        <Dialog.Close render={<Button variant="secondary">Cancel</Button>} />
        <Button variant={confirmTone} loading={loading} disabled={loading} onClick={() => void onConfirm()}>{confirmLabel}</Button>
      </div>
    </Dialog>
  </Dialog.Root>;
}
