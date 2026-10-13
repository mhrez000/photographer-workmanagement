"use client";

import * as React from "react";
import { Ban, Ellipsis, History, MessageCircleQuestion, Pencil, RotateCcw, Undo2, UserRoundPen, UserRoundX } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { SimpleJobPage } from "@/lib/types";
import { AssignEditorDialog } from "./assign-editor-dialog";
import { focusMessageComposer } from "./messages-thread";
import { ReopenDialog } from "./reopen-dialog";
import { CancelJobDialog, DeclineJobDialog, TakeBackDialog } from "./simple-dialogs";
import { useConflict } from "./use-conflict";

export interface JobMenuProps {
  page: SimpleJobPage;
  timeZone: string;
  className?: string;
}

/**
 * The ⋯ menu (plan §5). Owner / photographer on an ACTIVE job: Edit details, Change editor, Take back
 * from editor, Cancel job; on a Done job only Edit details and Reopen… (the model's permissions already
 * gate Change editor / Cancel to active stages). Editor: "Can't do this one" (greyed out once editing
 * has started, with a note to ask the photographer to take it back), Ask a question. Everyone: Full history.
 */
export function JobMenu({ page, timeZone, className }: JobMenuProps) {
  const { header, permissions, nextStep } = page;
  const { onConflict, conflictDialog } = useConflict(timeZone);
  const [dialog, setDialog] = React.useState<"change" | "takeBack" | "cancel" | "reopen" | "decline" | null>(null);
  const close = (open: boolean) => (open ? undefined : setDialog(null));
  const jobLabel = `${header.name} · ${header.client.name}`;
  const editorName = header.editedBy?.name ?? null;
  const photographer = header.shotBy?.name ?? "the photographer";
  const isEditor = nextStep.viewer === "editor";
  const stage = header.stage.stage;
  // The editor holds the job but editing has begun: the engine offers no way back (plan §5 "Can't do this one" is for a job not yet started).
  const declineLocked = isEditor && !permissions.canDecline && (stage === "changes_asked" || (stage === "with_editor" && header.stage.subLabel === "editing"));

  const askQuestion = () => {
    if (window.location.hash !== "#messages") window.history.replaceState(null, "", "#messages");
    // Let the menu close and the page settle before moving focus.
    window.setTimeout(focusMessageComposer, 50);
  };

  const items: React.ReactNode[] = [];
  if (permissions.canEditDetails) items.push(<DropdownMenuItem key="edit" icon={<Pencil />} href={`/jobs/${header.id}/edit`}>Edit details</DropdownMenuItem>);
  if (permissions.canChangeEditor) items.push(<DropdownMenuItem key="change" icon={<UserRoundPen />} onSelect={() => setDialog("change")}>Change editor</DropdownMenuItem>);
  if (permissions.canTakeBack) items.push(<DropdownMenuItem key="take" icon={<Undo2 />} onSelect={() => setDialog("takeBack")}>Take back from editor</DropdownMenuItem>);
  if (permissions.canReopen) items.push(<DropdownMenuItem key="reopen" icon={<RotateCcw />} onSelect={() => setDialog("reopen")}>Reopen…</DropdownMenuItem>);
  if (isEditor && permissions.canDecline) items.push(<DropdownMenuItem key="decline" icon={<UserRoundX />} onSelect={() => setDialog("decline")}>Can&apos;t do this one</DropdownMenuItem>);
  if (declineLocked) {
    items.push(
      <React.Fragment key="decline-locked">
        <DropdownMenuItem icon={<UserRoundX />} disabled aria-describedby="decline-locked-note">
          Can&apos;t do this one
        </DropdownMenuItem>
        <p id="decline-locked-note" className="px-2.5 pb-1.5 pt-0.5 text-xs leading-5 text-ink-muted" data-decline-locked="">
          Editing has started — ask {photographer} to take this back.
        </p>
      </React.Fragment>,
    );
  }
  if (isEditor && permissions.canComment) items.push(<DropdownMenuItem key="ask" icon={<MessageCircleQuestion />} onSelect={askQuestion}>Ask a question</DropdownMenuItem>);
  const history = <DropdownMenuItem key="history" icon={<History />} href={`/jobs/${header.id}/history`}>Full history</DropdownMenuItem>;
  const cancel = permissions.canCancel ? <DropdownMenuItem key="cancel" icon={<Ban />} destructive onSelect={() => setDialog("cancel")}>Cancel job</DropdownMenuItem> : null;

  return (
    <>
      <DropdownMenu className={className}>
        <DropdownMenuTrigger variant="outline" size="icon" aria-label="More actions">
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="More actions" width="16rem">
          {items}
          {items.length > 0 ? <DropdownMenuSeparator /> : null}
          {history}
          {cancel ? (
            <>
              <DropdownMenuSeparator />
              {cancel}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AssignEditorDialog
        open={dialog === "change"}
        onOpenChange={close}
        jobId={header.id}
        version={header.version}
        mode="change"
        currentEditorId={header.editedBy?.id ?? null}
        jobLabel={jobLabel}
        options={nextStep.editorOptions}
        onConflict={onConflict}
      />
      <TakeBackDialog open={dialog === "takeBack"} onOpenChange={close} jobId={header.id} version={header.version} editorName={editorName} onConflict={onConflict} />
      <CancelJobDialog open={dialog === "cancel"} onOpenChange={close} jobId={header.id} version={header.version} jobLabel={jobLabel} onConflict={onConflict} />
      <ReopenDialog open={dialog === "reopen"} onOpenChange={close} jobId={header.id} version={header.version} editorName={editorName} jobLabel={jobLabel} onConflict={onConflict} />
      <DeclineJobDialog open={dialog === "decline"} onOpenChange={close} jobId={header.id} version={header.version} jobLabel={jobLabel} onConflict={onConflict} />
      {conflictDialog}
    </>
  );
}
