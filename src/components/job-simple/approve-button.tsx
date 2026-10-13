"use client";

import * as React from "react";
import { BadgeCheck, Send } from "lucide-react";
import { ConfirmDialog } from "@/components/common";
import { useMutationRunner } from "@/components/jobs";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import type { ApiError } from "@/lib/api-client";
import { LINK_KIND_META, SELF_APPROVAL_CONFIRM_MESSAGE } from "@/lib/constants";
import type { SimpleLink } from "@/lib/types";
import { simpleJobApi } from "./api";

type ButtonLook = Pick<Extract<ButtonProps, { href?: undefined }>, "size" | "variant" | "className">;

export interface ApproveButtonProps extends ButtonLook {
  jobId: string;
  version: number;
  /** The client's name, for "Share the finished photos with Ray White Bondi?". */
  clientName: string;
  /** The client uses the portal: ask Approve & send / Approve only (plan §12.2). */
  shareQuestion: boolean;
  /** Owner / co-owner edited this themselves: "You edited this yourself. Approve anyway?" (plan §12.3). */
  selfReviewNeedsConfirm: boolean;
  /** Current finished / gallery / download links offered as share ticks (all ticked by default). */
  shareableLinks?: SimpleLink[];
  /** The finished link, for "Copy link to send the client" when the client has no portal. */
  finishedLink?: SimpleLink | null;
  onConflict?: (error: ApiError) => void;
  onDone?: () => void;
  label?: string;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one Approve button (plan §5). Self-approval confirm → (portal) share question
 * → approve. Without a portal the job finishes straight away and offers the
 * finished link to copy.
 */
export function ApproveButton({
  jobId,
  version,
  clientName,
  shareQuestion,
  selfReviewNeedsConfirm,
  shareableLinks = [],
  finishedLink = null,
  onConflict,
  onDone,
  label = "Approve",
  size,
  variant = "primary",
  className,
}: ApproveButtonProps) {
  const run = useMutationRunner();
  const [confirmSelf, setConfirmSelf] = React.useState(false);
  const [askShare, setAskShare] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const approve = async (share: "send" | "only" | "n/a", shareLinkIds?: string[]) => {
    setBusy(true);
    const result = await run(
      () =>
        simpleJobApi.approve(jobId, {
          expectedVersion: version,
          share,
          ...(selfReviewNeedsConfirm ? { confirmSelfApproval: true } : {}),
          ...(share === "send" && shareLinkIds ? { shareLinkIds } : {}),
        }),
      { onConflict, noRefresh: false },
    );
    setBusy(false);
    if (!result.ok) return false;
    if (share === "send") toast.success("Approved and sent", `${clientName} can see the finished photos.`);
    else if (share === "only") toast.success("Approved", "Not sent to the client yet.");
    else if (finishedLink) {
      toast({
        title: "Approved · Done",
        description: "Send the client the finished link.",
        variant: "success",
        duration: 10_000,
        action: {
          label: "Copy link to send the client",
          onClick: () => {
            void copyText(finishedLink.url).then((ok) => (ok ? toast.success("Link copied") : toast.error("Could not copy the link")));
          },
        },
      });
    } else toast.success("Approved · Done");
    onDone?.();
    return true;
  };

  const next = () => {
    if (shareQuestion) setAskShare(true);
    else void approve("n/a");
  };

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={className}
        leadingIcon={<BadgeCheck aria-hidden="true" />}
        loading={busy && !askShare}
        onClick={() => (selfReviewNeedsConfirm ? setConfirmSelf(true) : next())}
      >
        {label}
      </Button>

      <ConfirmDialog
        open={confirmSelf}
        onOpenChange={setConfirmSelf}
        title={SELF_APPROVAL_CONFIRM_MESSAGE}
        description="Owners may approve their own edit. This is recorded in the job's history."
        confirmLabel="Approve anyway"
        onConfirm={() => {
          setConfirmSelf(false);
          // Let the confirm close before the next dialog opens.
          window.setTimeout(next, 0);
        }}
      />

      <ShareDialog
        open={askShare}
        onOpenChange={setAskShare}
        clientName={clientName}
        links={shareableLinks}
        busy={busy}
        sendLabel="Approve & send"
        onlyLabel="Approve only"
        onSend={async (ids) => {
          const ok = await approve("send", ids);
          if (ok) setAskShare(false);
        }}
        onOnly={async () => {
          const ok = await approve("only");
          if (ok) setAskShare(false);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Share question                                                      */
/* ------------------------------------------------------------------ */

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientName: string;
  links: SimpleLink[];
  busy: boolean;
  sendLabel: string;
  /** Omit for a plain "Send to client" dialog (no "only" branch). */
  onlyLabel?: string;
  onSend: (shareLinkIds: string[] | undefined) => void | Promise<void>;
  onOnly?: () => void | Promise<void>;
}

/** "Share the finished photos with <client>?" with a tick per link (plan §5 Approve). */
function ShareDialog(props: ShareDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => (props.busy ? undefined : props.onOpenChange(next))} size="sm">
      {props.open ? <ShareBody {...props} /> : null}
    </Dialog>
  );
}

/** Mounted only while open, so the ticks start fresh (all on) every time. */
function ShareBody({ onOpenChange, clientName, links, busy, sendLabel, onlyLabel, onSend, onOnly }: ShareDialogProps) {
  const [ticked, setTicked] = React.useState<Set<string>>(() => new Set(links.map((l) => l.id)));
  const ids = links.length > 0 ? links.filter((l) => ticked.has(l.id)).map((l) => l.id) : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Share the finished photos with {clientName}?</DialogTitle>
        <DialogDescription>{links.length > 0 ? "They will see the job as Delivered, with the links ticked below." : "They will see the job as Delivered."}</DialogDescription>
      </DialogHeader>
      {links.length > 0 ? (
        <DialogBody className="pb-4">
          <ul className="flex flex-col gap-2">
            {links.map((l) => (
              <li key={l.id}>
                <Checkbox
                  checked={ticked.has(l.id)}
                  onChange={(e) =>
                    setTicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(l.id);
                      else next.delete(l.id);
                      return next;
                    })
                  }
                  label={l.label?.trim() || LINK_KIND_META[l.kind].label}
                  description={<span className="break-all">{l.url}</span>}
                  disabled={busy}
                />
              </li>
            ))}
          </ul>
        </DialogBody>
      ) : null}
      <DialogFooter>
        {onlyLabel && onOnly ? (
          <Button variant="outline" onClick={() => void onOnly()} disabled={busy}>
            {onlyLabel}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button variant="primary" leadingIcon={<Send aria-hidden="true" />} onClick={() => void onSend(ids)} loading={busy} autoFocus>
          {sendLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Send to client (Done · Not sent to client)                          */
/* ------------------------------------------------------------------ */

export interface SendToClientButtonProps extends ButtonLook {
  jobId: string;
  version: number;
  clientName: string;
  shareableLinks?: SimpleLink[];
  onConflict?: (error: ApiError) => void;
}

/** On a Done job the client has not been sent yet (plan §4 "Not sent to client"): the delivery step, with the same share ticks. */
export function SendToClientButton({ jobId, version, clientName, shareableLinks = [], onConflict, size, variant = "primary", className }: SendToClientButtonProps) {
  const run = useMutationRunner();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <>
      <Button size={size} variant={variant} className={className} leadingIcon={<Send aria-hidden="true" />} onClick={() => setOpen(true)}>
        Send to client
      </Button>
      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        clientName={clientName}
        links={shareableLinks}
        busy={busy}
        sendLabel="Send to client"
        onSend={async (ids) => {
          setBusy(true);
          const result = await run(() => simpleJobApi.sendToClient(jobId, { expectedVersion: version, ...(ids ? { shareLinkIds: ids } : {}) }), {
            success: "Sent to client",
            successDescription: `${clientName} can see the finished photos.`,
            onConflict,
          });
          setBusy(false);
          if (result.ok) setOpen(false);
        }}
      />
    </>
  );
}
