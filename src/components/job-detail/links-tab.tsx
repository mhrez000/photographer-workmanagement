"use client";

import * as React from "react";
import { ArrowRightLeft, ChevronDown, ChevronRight, History, Link2, PencilLine, Plus, Replace, Trash2 } from "lucide-react";
import { ExternalLinkButton, LinkProviderIcon, ReasonDialog, linkHost, toDialogResult, useMutationRunner, firstFieldErrors, type FieldErrors } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { LINK_KIND_META, LINK_KINDS, type LinkKind } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { LinkSlot, LinkView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { displayUrlParts, slotKind } from "./format";

export interface LinkPermissions {
  canReplace: boolean;
  canRemove: boolean;
}

export interface LinksTabProps {
  jobId: string;
  slots: LinkSlot[];
  /** Kinds the viewer may add (JobAvailableActions.canAddLinkKinds). */
  canAddKinds: LinkKind[];
  /** Per current link id. */
  permissions: Record<string, LinkPermissions>;
  timeZone: string;
}

type DialogState =
  | { kind: "none" }
  | { kind: "add"; linkKind: LinkKind | null }
  | { kind: "replace"; link: LinkView }
  | { kind: "rename"; link: LinkView }
  | { kind: "remove"; link: LinkView };

/* ------------------------------------------------------------------ */
/*  Add / replace form                                                  */
/* ------------------------------------------------------------------ */

interface LinkFormProps {
  mode: "add" | "replace";
  title: string;
  description: string;
  kinds?: LinkKind[];
  initialKind?: LinkKind | null;
  initialLabel?: string;
  onCancel: () => void;
  onSubmit: (values: { kind: LinkKind; url: string; label: string }) => Promise<true | FieldErrors | false>;
}

function LinkForm({ mode, title, description, kinds = [], initialKind, initialLabel = "", onCancel, onSubmit }: LinkFormProps) {
  const [kind, setKind] = React.useState<LinkKind>(initialKind ?? kinds[0] ?? "other");
  const [url, setUrl] = React.useState("");
  const [label, setLabel] = React.useState(initialLabel);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!/^https?:\/\/\S+/i.test(trimmed)) {
      setErrors({ url: "Enter a full http:// or https:// link" });
      return;
    }
    setSubmitting(true);
    setErrors({});
    try {
      const result = await onSubmit({ kind, url: trimmed, label: label.trim() });
      if (result !== true && result !== false) setErrors(firstFieldErrors(result));
    } finally {
      setSubmitting(false);
    }
  };

  const host = linkHost(url.trim());

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        {mode === "add" ? (
          <FormField label="Kind" required error={errors.kind}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as LinkKind)} options={kinds.map((k) => ({ value: k, label: LINK_KIND_META[k].label }))} />
          </FormField>
        ) : null}
        <FormField label="Link" required error={errors.url} description="Paste a share link from Drive, Dropbox, OneDrive, Frame.io, WeTransfer, Lightroom or any https:// address. Files stay where they are.">
          <Input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            autoFocus
            autoComplete="off"
            leading={<LinkProviderIcon url={url.trim() || null} />}
            trailing={host ? <span className="max-w-32 truncate text-2xs">{host}</span> : undefined}
          />
        </FormField>
        <FormField label="Label" optional error={errors.label} description={mode === "replace" ? "Leave as is to keep the current label." : undefined}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Final gallery, Client selects" maxLength={200} />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          {mode === "add" ? "Add link" : "Replace link"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Slot card                                                           */
/* ------------------------------------------------------------------ */

function HistoryChain({ entries, timeZone }: { entries: LinkView[]; timeZone: string }) {
  if (entries.length === 0) return null;
  return (
    <details className="group mt-3 rounded-md border border-border bg-surface-sunken/70 px-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-2 text-xs font-medium text-ink-secondary focus-ring rounded-xs [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
        <History aria-hidden="true" className="size-3.5" />
        {entries.length} earlier {entries.length === 1 ? "version" : "versions"}
      </summary>
      <ol className="relative mb-2 ml-1.5 border-l border-border pl-4">
        {entries.map((h) => (
          <li key={h.id} className="relative py-1.5">
            <span aria-hidden="true" className="absolute -left-[21px] top-3 size-2 rounded-full bg-border-strong ring-2 ring-surface-sunken" />
            <a href={h.url} target="_blank" rel="noopener noreferrer" title={h.url} className="block truncate text-sm text-ink-secondary line-through decoration-ink-subtle/60 hover:text-ink focus-ring rounded-xs">
              {h.label ?? h.url}
            </a>
            <p className="text-2xs text-ink-subtle numeric">
              Added by {h.addedBy.name} · {formatDate(h.createdAt, timeZone)}
              {h.supersededAt ? ` · replaced ${formatDateTime(h.supersededAt, timeZone)}` : ""}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Host + path with the middle ellipsised ("dropbox.com/sh/…uxqa-raw-2"); the full URL is in the title. */
function UrlLine({ url }: { url: string }) {
  const parts = displayUrlParts(url);
  if (!parts) return null;
  return (
    <p title={url} data-link-url="" className="flex min-w-0 font-mono text-2xs text-ink-muted">
      <span className="truncate">{parts.head}</span>
      {parts.tail ? <span className="shrink-0">{parts.tail}</span> : null}
    </p>
  );
}

function SlotCard({
  slot,
  perms,
  moveKinds,
  timeZone,
  onReplace,
  onRename,
  onMove,
  onRemove,
}: {
  slot: LinkSlot;
  perms: LinkPermissions | undefined;
  /** Kinds this link may move to: the viewer's add-link kinds minus its own. */
  moveKinds: LinkKind[];
  timeZone: string;
  onReplace: (link: LinkView) => void;
  onRename: (link: LinkView) => void;
  onMove: (link: LinkView, kind: LinkKind) => void;
  onRemove: (link: LinkView) => void;
}) {
  const current = slot.current;
  const last = slot.history[slot.history.length - 1];
  const earlier = slot.history.filter((h) => h.id !== (current ?? last)?.id).reverse();

  if (!current && last) {
    return (
      <li className="rounded-md border border-dashed border-border bg-surface-sunken/50 p-3">
        <div className="flex items-start gap-3 opacity-80">
          <LinkProviderIcon provider={last.provider} url={last.url} className="mt-0.5 size-4 text-ink-subtle" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-ink-muted line-through">{last.label ?? last.url}</p>
            <p className="text-2xs text-ink-subtle">
              Removed {last.removedAt ? formatDateTime(last.removedAt, timeZone) : ""}
              {last.removedBy ? ` by ${last.removedBy.name}` : ""}
              {last.removeReason ? ` — “${last.removeReason}”` : ""}
            </p>
          </div>
        </div>
        <HistoryChain entries={earlier} timeZone={timeZone} />
      </li>
    );
  }
  if (!current) return null;

  // Rename / move follow the same actor rule as replace (owners, managers, own photographer, the editor who added it).
  const canEdit = Boolean(perms?.canReplace);
  const hasActions = canEdit || Boolean(perms?.canRemove);

  return (
    <li className="min-w-0 rounded-md border border-border bg-surface p-3 transition-colors hover:border-border-hover">
      <div className="min-w-0">
        <ExternalLinkButton url={current.url} label={current.label} provider={current.provider} variant="ghost" hideHost className="-ml-2.5 max-w-full" />
        <UrlLine url={current.url} />
        <p className="mt-1 text-xs text-ink-muted numeric">
          Added by {current.addedBy.name} · <time dateTime={current.createdAt}>{formatDateTime(current.createdAt, timeZone)}</time>
          {current.supersedesLinkId ? " · replaced an earlier link" : ""}
        </p>
      </div>
      {/* Actions stack under the link so a narrow card never squeezes the link text. */}
      {hasActions ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-border pt-2.5">
          {canEdit ? (
            <>
              <Button variant="outline" size="sm" leadingIcon={<Replace aria-hidden="true" />} onClick={() => onReplace(current)}>
                Replace
              </Button>
              <Button variant="ghost" size="sm" leadingIcon={<PencilLine aria-hidden="true" />} onClick={() => onRename(current)}>
                Rename
              </Button>
              {moveKinds.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger variant="ghost" size="sm" leadingIcon={<ArrowRightLeft aria-hidden="true" />} trailingIcon={<ChevronDown aria-hidden="true" />}>
                    Move to…
                  </DropdownMenuTrigger>
                  <DropdownMenuContent aria-label="Move link to" width="13rem">
                    <DropdownMenuLabel>Move to</DropdownMenuLabel>
                    {moveKinds.map((k) => (
                      <DropdownMenuItem key={k} onSelect={() => onMove(current, k)}>
                        {LINK_KIND_META[k].label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          ) : null}
          {perms?.canRemove ? (
            <span className="ml-auto">
              <Tooltip content="Remove link (kept in history)" align="end">
                <IconButton label="Remove link" size="sm" variant="ghost" onClick={() => onRemove(current)}>
                  <Trash2 />
                </IconButton>
              </Tooltip>
            </span>
          ) : null}
        </div>
      ) : null}
      <HistoryChain entries={earlier} timeZone={timeZone} />
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Rename                                                              */
/* ------------------------------------------------------------------ */

function RenameForm({
  link,
  onCancel,
  onSubmit,
}: {
  link: LinkView;
  onCancel: () => void;
  onSubmit: (label: string | null) => Promise<true | FieldErrors | false>;
}) {
  const [label, setLabel] = React.useState(link.label ?? "");
  const [error, setError] = React.useState<string | undefined>();
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await onSubmit(label.trim() || null);
      if (result !== true && result !== false) {
        const errors = firstFieldErrors(result);
        setError(errors.label ?? Object.values(errors)[0]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>Rename link</DialogTitle>
        <DialogDescription>Only the label changes — the link and its history stay as they are.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <FormField label="Label" optional error={error} description="Leave empty to show the provider name.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Final gallery, Client selects" maxLength={200} autoFocus />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          Save label
        </Button>
      </DialogFooter>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab                                                                 */
/* ------------------------------------------------------------------ */

/** External links grouped by kind, each a supersession chain with full history (spec §4, §35). */
export function LinksTab({ jobId, slots, canAddKinds, permissions, timeZone }: LinksTabProps) {
  const run = useMutationRunner();
  const [dialog, setDialog] = React.useState<DialogState>({ kind: "none" });
  const close = () => setDialog({ kind: "none" });

  const kindsShown = LINK_KINDS.filter((k) => slots.some((s) => slotKind(s) === k) || canAddKinds.includes(k));
  const hasAny = slots.length > 0;

  const addLink = async (values: { kind: LinkKind; url: string; label: string }) => {
    const result = await run(() => api.post(`/api/jobs/${jobId}/links`, { kind: values.kind, url: values.url, label: values.label || null }), {
      success: `${LINK_KIND_META[values.kind].label} link added`,
    });
    if (result.ok) close();
    const r = toDialogResult(result);
    return r === true ? true : typeof r === "object" ? r.fieldErrors : false;
  };

  const replaceLink = (link: LinkView) => async (values: { url: string; label: string }) => {
    const label = values.label === (link.label ?? "") ? undefined : values.label || null;
    const result = await run(() => api.post(`/api/links/${link.id}/replace`, { url: values.url, ...(label !== undefined ? { label } : {}) }), {
      success: "Link replaced — the old one is kept in history",
    });
    if (result.ok) close();
    const r = toDialogResult(result);
    return r === true ? true : typeof r === "object" ? r.fieldErrors : false;
  };

  /** PATCH /api/links/:id — rename (label) or move to another kind, in place (no new version in the chain). */
  const updateLink = async (link: LinkView, body: { kind?: LinkKind; label?: string | null }, success: string) => {
    const result = await run(() => api.patch(`/api/links/${link.id}`, body), { success });
    // A 422 with field errors is not toasted by the runner; the move menu has no form to show it on.
    if (!result.ok && result.fieldErrors && body.kind !== undefined) {
      toast.error("Could not move the link", Object.values(firstFieldErrors(result.fieldErrors))[0]);
    }
    return result;
  };

  const renameLink = (link: LinkView) => async (label: string | null) => {
    if (label === (link.label ?? null)) {
      close();
      return true as const;
    }
    const result = await updateLink(link, { label }, "Link renamed");
    if (result.ok) close();
    const r = toDialogResult(result);
    return r === true ? true : typeof r === "object" ? r.fieldErrors : false;
  };

  const moveLink = (link: LinkView, kind: LinkKind) => {
    void updateLink(link, { kind }, `Moved to ${LINK_KIND_META[kind].label}`);
  };

  return (
    <div className="@container flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-ink-muted">
          Files stay in Drive, Dropbox, Frame.io and friends — this is where everyone finds them. Replacing or removing a link keeps the old one in history.
        </p>
        {canAddKinds.length > 0 ? (
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setDialog({ kind: "add", linkKind: null })}>
            Add link
          </Button>
        ) : null}
      </div>

      {!hasAny ? (
        <Card>
          <EmptyState
            icon={Link2}
            title="No links on this job yet"
            description={
              canAddKinds.length > 0
                ? "Add the raw files, the editing workspace or the finished gallery so nobody has to hunt for them."
                : "Links to raw files, the editing workspace and finished work will appear here once they are added."
            }
            action={
              canAddKinds.length > 0 ? (
                <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setDialog({ kind: "add", linkKind: null })}>
                  Add the first link
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        // Container query: two columns only when the tab column itself is wide enough (not the viewport).
        <div className="grid gap-4 @3xl:grid-cols-2">
          {kindsShown.map((kind) => {
            const ofKind = slots.filter((s) => slotKind(s) === kind);
            const meta = LINK_KIND_META[kind];
            const canAdd = canAddKinds.includes(kind);
            return (
              <Card key={kind} tone={meta.finishedWork && ofKind.some((s) => s.current) ? "accent" : "default"} className={cn("p-4", ofKind.length === 0 && "border-dashed bg-surface-sunken/40 shadow-none")}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                    {meta.label}
                    {meta.finishedWork ? <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent-ink">Finished work</span> : null}
                  </h3>
                  {canAdd ? (
                    <Button variant="ghost" size="sm" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setDialog({ kind: "add", linkKind: kind })} aria-label={`Add ${meta.label} link`}>
                      Add
                    </Button>
                  ) : null}
                </div>
                {ofKind.length === 0 ? (
                  <p className="text-xs text-ink-subtle">Nothing linked yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {ofKind.map((slot) => (
                      <SlotCard
                        key={slot.history[0]?.id ?? slot.kind}
                        slot={slot}
                        perms={slot.current ? permissions[slot.current.id] : undefined}
                        moveKinds={canAddKinds.filter((k) => k !== kind)}
                        timeZone={timeZone}
                        onReplace={(link) => setDialog({ kind: "replace", link })}
                        onRename={(link) => setDialog({ kind: "rename", link })}
                        onMove={moveLink}
                        onRemove={(link) => setDialog({ kind: "remove", link })}
                      />
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialog.kind === "rename"} onOpenChange={(open) => (!open ? close() : undefined)} size="sm">
        {dialog.kind === "rename" ? <RenameForm key={dialog.link.id} link={dialog.link} onCancel={close} onSubmit={renameLink(dialog.link)} /> : null}
      </Dialog>

      <Dialog open={dialog.kind === "add" || dialog.kind === "replace"} onOpenChange={(open) => (!open ? close() : undefined)} size="md">
        {dialog.kind === "add" ? (
          <LinkForm
            mode="add"
            title={dialog.linkKind ? `Add ${LINK_KIND_META[dialog.linkKind].label.toLowerCase()} link` : "Add a link"}
            description="Links are external — nothing is uploaded."
            kinds={canAddKinds}
            initialKind={dialog.linkKind}
            onCancel={close}
            onSubmit={addLink}
          />
        ) : dialog.kind === "replace" ? (
          <LinkForm
            mode="replace"
            title={`Replace ${LINK_KIND_META[dialog.link.kind].label.toLowerCase()} link`}
            description={`The current link (${linkHost(dialog.link.url) ?? dialog.link.url}) stays in the history chain.`}
            initialLabel={dialog.link.label ?? ""}
            onCancel={close}
            onSubmit={(values) => replaceLink((dialog as { link: LinkView }).link)(values)}
          />
        ) : null}
      </Dialog>

      <ReasonDialog
        open={dialog.kind === "remove"}
        onOpenChange={(open) => (!open ? close() : undefined)}
        title="Remove this link?"
        description={dialog.kind === "remove" ? `“${dialog.link.label ?? dialog.link.url}” will no longer be current. It stays visible in the link history and the audit log.` : undefined}
        required={false}
        label="Reason"
        placeholder="Optional — e.g. wrong folder, expired share"
        confirmLabel="Remove link"
        destructive
        onSubmit={async (reason) => {
          if (dialog.kind !== "remove") return false;
          const result = await run(() => api.post(`/api/links/${dialog.link.id}/remove`, { reason: reason || null }), { success: "Link removed" });
          return toDialogResult(result);
        }}
      />
    </div>
  );
}
