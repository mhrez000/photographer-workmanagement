"use client";

import * as React from "react";
import { PackageCheck, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LINK_KIND_META } from "@/lib/constants";
import { addedAfterApproval, defaultDeliverySelection, type DeliverContext } from "@/lib/sharing";
import type { DialogSubmitResult } from "./mutation";

/** Body of the delivering move (`POST /api/jobs/:id/transition { delivery }`, ROLES.md §7.3). */
export interface DeliveryChoice {
  shareJob?: boolean;
  shareLinkIds?: string[];
}

export interface DeliverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobLabel?: string;
  context: DeliverContext;
  onSubmit: (delivery: DeliveryChoice) => Promise<DialogSubmitResult> | DialogSubmitResult;
}

/**
 * Deliver dialog (ROLES.md §7.3, §11): optionally share the job with the client and
 * pick which current links the client may open. Gallery / client-delivery links are
 * pre-selected, else finished files; delivering a client-visible job with nothing to
 * open needs an explicit "Deliver without links".
 */
export function DeliverDialog(props: DeliverDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} size="md">
      {props.open ? <DeliverForm {...props} /> : null}
    </Dialog>
  );
}

function DeliverForm({ onOpenChange, jobLabel, context, onSubmit }: DeliverDialogProps) {
  const { clientName, visibleToClient, canShareJob, approvedAt, links } = context;
  const alreadyShared = links.filter((l) => l.sharedWithClient);
  const choosable = links.filter((l) => !l.sharedWithClient && l.canShare);
  const [shareJob, setShareJob] = React.useState(!visibleToClient && canShareJob);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(defaultDeliverySelection(choosable)));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const willBeVisible = visibleToClient || shareJob;
  const openable = alreadyShared.length + (willBeVisible ? selected.size : 0);
  const emptyDelivery = willBeVisible && openable === 0;

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const delivery: DeliveryChoice = {
        ...(shareJob && !visibleToClient ? { shareJob: true } : {}),
        // Only a client-visible job publishes links; an explicit list (possibly empty) replaces the default set.
        ...(willBeVisible ? { shareLinkIds: choosable.filter((l) => selected.has(l.id)).map((l) => l.id) } : {}),
      };
      const result = await onSubmit(delivery);
      if (result === true) onOpenChange(false);
      else if (typeof result === "object") setError("The job could not be delivered. Check the selection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>{jobLabel ? `Deliver ${jobLabel}` : "Deliver this job"}</DialogTitle>
        <DialogDescription>
          {willBeVisible
            ? `${clientName} sees the job as Delivered in their portal and can open the links you choose.`
            : `The job is not shared with ${clientName}; it is delivered without publishing anything to their portal.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        {!visibleToClient && canShareJob ? (
          <Checkbox
            checked={shareJob}
            onChange={(e) => setShareJob(e.target.checked)}
            label={`Share this job with ${clientName} now`}
            description="They get a notification and see it in their portal."
          />
        ) : null}

        {willBeVisible ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Links the client can open</legend>
            {alreadyShared.map((l) => (
              <LinkRow key={l.id} link={l} approvedAt={approvedAt} checked disabled note="Already visible to the client" />
            ))}
            {choosable.map((l) => (
              <LinkRow key={l.id} link={l} approvedAt={approvedAt} checked={selected.has(l.id)} onChange={(on) => toggle(l.id, on)} />
            ))}
            {links.length === 0 ? <p className="text-sm text-ink-muted">This job has no links yet.</p> : null}
          </fieldset>
        ) : null}

        {emptyDelivery ? (
          <p role="status" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-ink">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            The client will see Delivered with nothing to open.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} leadingIcon={<PackageCheck aria-hidden="true" />}>
          {emptyDelivery ? "Deliver without links" : "Deliver"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function LinkRow({
  link,
  approvedAt,
  checked,
  disabled = false,
  note,
  onChange,
}: {
  link: DeliverContext["links"][number];
  approvedAt: string | null;
  checked: boolean;
  disabled?: boolean;
  note?: string;
  onChange?: (on: boolean) => void;
}) {
  const late = addedAfterApproval(link, approvedAt);
  return (
    <Checkbox
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.checked)}
      wrapperClassName="items-start rounded-md border border-border px-3 py-2"
      label={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-ink">{link.label ?? LINK_KIND_META[link.kind].label}</span>
          <Badge variant="neutral" size="sm">
            {LINK_KIND_META[link.kind].label}
          </Badge>
          {late ? (
            <Badge variant="warning" size="sm">
              Added after approval
            </Badge>
          ) : null}
        </span>
      }
      description={
        <span className="block min-w-0">
          <span className="block break-all text-ink-muted">{link.url}</span>
          <span className="text-ink-subtle">
            Added by {link.addedByName}
            {note ? ` · ${note}` : ""}
          </span>
        </span>
      }
    />
  );
}
