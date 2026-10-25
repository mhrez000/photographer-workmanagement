"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MonitorSmartphone } from "lucide-react";
import { FormAlert } from "@/components/auth/form-alert";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { accountErrorMessage } from "./account-errors";

/** One label for the card button, the dialog title and its confirm button (UX-04: one verb, one wording). */
export const LOG_OUT_OTHERS_LABEL = "Log out of other devices";

/**
 * "Log out of other devices" (POST /api/auth/sign-out-others): a confirm step, then every other phone, computer and
 * browser is logged out while this one stays signed in (the server re-issues this browser's cookie). The card also
 * says what the menu's "Log out" does — it logs out everywhere, this device included (UX-03).
 */
export function SignOutOthersPanel() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirm = async (): Promise<boolean> => {
    setError(null);
    try {
      await api.post("/api/auth/sign-out-others");
      setDone(true);
      router.refresh();
      return true;
    } catch (err) {
      setError(accountErrorMessage(err));
      return true; // close the dialog; the message shows on the card
    }
  };

  return (
    <div className="flex flex-col gap-3" data-sign-out-others="">
      {done ? (
        <FormAlert tone="success">
          <span className="font-medium">Done.</span> Every other device is logged out. You’re still signed in here.
        </FormAlert>
      ) : null}
      {error ? <FormAlert>{error}</FormAlert> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-ink-secondary">
            Signed in on a shared computer, an old phone or someone else’s browser? Log them all out at once and stay signed in here.
          </p>
          <p className="text-xs text-ink-muted">“Log out” in the menu logs you out everywhere, this device included.</p>
        </div>
        <Button
          variant="outline"
          className="shrink-0"
          leadingIcon={<MonitorSmartphone aria-hidden="true" />}
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          {LOG_OUT_OTHERS_LABEL}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`${LOG_OUT_OTHERS_LABEL}?`}
        description="Every other phone, computer and browser signed in to your account will be logged out. You stay signed in here."
        confirmLabel={LOG_OUT_OTHERS_LABEL}
        onConfirm={confirm}
      />
    </div>
  );
}
