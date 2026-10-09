"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional extra content (lists of affected items, etc.). */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + warning icon. */
  destructive?: boolean;
  /**
   * Runs on confirm. Return/resolve `false` to keep the dialog open (e.g. on
   * error); anything else closes it. A spinner shows while it is pending.
   */
  onConfirm: () => unknown | Promise<unknown>;
}

/** Yes/no confirmation for consequential actions, with a pending state. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      const result = await onConfirm();
      if (result !== false) onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))} size="sm">
      <DialogHeader>
        {destructive ? (
          <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger ring-1 ring-inset ring-danger/15">
            <TriangleAlert aria-hidden="true" className="size-5" />
          </div>
        ) : null}
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      {children ? <DialogBody className="pb-4">{children}</DialogBody> : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={confirm} loading={pending} autoFocus>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
