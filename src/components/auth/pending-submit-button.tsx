"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonAsButtonProps } from "@/components/ui/button";

export type PendingSubmitButtonProps = Omit<ButtonAsButtonProps, "type" | "loading"> & {
  /** The label while the form is being sent (e.g. "Logging out…"). */
  pendingLabel?: React.ReactNode;
};

/**
 * A submit button for a server-action `<form>` rendered by a server component (the signed-in notice, the demo
 * banner): spinner + disabled while the action runs, so a second tap never sends it twice.
 */
export function PendingSubmitButton({ children, pendingLabel, ...props }: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button {...props} type="submit" loading={pending}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
