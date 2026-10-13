"use client";

import * as React from "react";
import { ChevronDown, ExternalLink, Images, MessageSquareText, RotateCcw, Send, UserRoundPen } from "lucide-react";
import { CopyButton } from "@/components/common";
import { agoWords, dueWords, secondsBetween } from "@/components/jobs-list/format";
import { RoundBadge } from "@/components/jobs/stage-pill";
import { Button } from "@/components/ui/button";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { ChangesAskedRound, LinkView, SimpleJobPage, SimpleLink } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ApproveButton, SendToClientButton } from "./approve-button";
import { AskForChangesDialog } from "./ask-for-changes-dialog";
import { AssignEditorDialog } from "./assign-editor-dialog";
import { SendForCheckingDialog, SendForCheckingForm } from "./send-for-checking";
import { RestoreButton, StartEditingButton } from "./simple-dialogs";
import { useConflict } from "./use-conflict";

export interface NextStepCardProps {
  page: SimpleJobPage;
  timeZone: string;
  /** Server clock (ISO) for "sent 3 h ago". */
  now: string;
  /** Pinned to the bottom on phones: tighter padding, one line where possible. */
  pinned?: boolean;
  className?: string;
}

const toSimple = (l: LinkView | null): SimpleLink | null => (l ? { id: l.id, kind: l.kind, url: l.url, label: l.label, addedAt: l.createdAt } : null);

/** Current finished-kind links the checker may share (the latest first). */
function shareable(page: SimpleJobPage): SimpleLink[] {
  const out: SimpleLink[] = [];
  const f = toSimple(page.files.finished);
  if (f) out.push(f);
  for (const l of page.files.earlierVersions) if (l.isCurrent) out.push({ id: l.id, kind: l.kind, url: l.url, label: l.label, addedAt: l.createdAt });
  return out;
}

function lowerDue(page: SimpleJobPage): string | null {
  if (!page.header.due.civilDate) return null;
  const { label } = dueWords(page.header.due, page.header.stage.active);
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** "Done 12 Oct · on time · edited by Sam · 1 round of changes." */
function doneSentence(page: SimpleJobPage, timeZone: string): string {
  const w = page.whoDidWhat;
  const approved = [...w].reverse().find((e) => e.kind === "approved") ?? [...w].reverse().find((e) => e.kind === "sent_to_client" || e.kind === "closed");
  const sent = w.find((e) => e.kind === "sent_for_checking");
  const rounds = page.changesAsked.length;
  const parts = [`Done${approved ? ` ${formatDateShort(approved.at, timeZone)}` : ""}`];
  if (sent?.onTime === true) parts.push("on time");
  else if (sent?.onTime === false) parts.push("late");
  if (page.header.editedBy) parts.push(`edited by ${page.header.editedBy.name}`);
  parts.push(rounds === 0 ? "no changes asked" : `${rounds} ${rounds === 1 ? "round" : "rounds"} of changes`);
  return `${parts.join(" · ")}.`;
}

function latestRequest(rounds: ChangesAskedRound[]): ChangesAskedRound | null {
  return rounds.find((r) => r.status === "open") ?? rounds[rounds.length - 1] ?? null;
}

function OpenLink({ link, label, primary = false, iconOnly = false }: { link: SimpleLink | LinkView | null; label: string; primary?: boolean; iconOnly?: boolean }) {
  if (!link) return null;
  if (iconOnly) {
    // The pinned phone bar: the label becomes the accessible name so the row stays one line.
    return (
      <Button href={link.url} target="_blank" rel="noopener noreferrer" variant="outline" aria-label={label} title={label} className="w-10 px-0">
        <Images aria-hidden="true" />
      </Button>
    );
  }
  return (
    <Button href={link.url} target="_blank" rel="noopener noreferrer" variant={primary ? "primary" : "outline"} leadingIcon={primary ? <Images aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}>
      {label}
    </Button>
  );
}

/** Scrolls the page's "Changes asked" section into view (the pinned phone bar's "See request"). */
function scrollToChangesAsked() {
  document.getElementById("changes")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * The "Next step" card (docs/SIMPLIFICATION-PLAN.md §5): one sentence and at
 * most two buttons, by stage × viewer. Every button is a one-press step; the
 * only real choice is Approve / Ask for changes.
 *
 * `pinned` (phones, fixed above the tab bar) keeps the bar to one sentence and
 * the buttons (about 64 to 96 px): the editor's finished-link box, "I updated
 * the same link" and the quoted request open in `SendForCheckingDialog` from
 * the primary button, and "See request" scrolls to the Changes asked section.
 */
export function NextStepCard({ page, timeZone, now, pinned = false, className }: NextStepCardProps) {
  const { header, nextStep, files, permissions, sideColumn } = page;
  const { onConflict, conflictDialog } = useConflict(timeZone);
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [changesOpen, setChangesOpen] = React.useState(false);
  const [sendOpen, setSendOpen] = React.useState(false);

  const editor = header.editedBy?.name ?? null;
  const shooter = header.shotBy?.name ?? null;
  const due = lowerDue(page);
  const jobLabel = `${header.name} · ${header.client.name}`;
  const stage = header.stage.stage;
  const viewer = nextStep.viewer;
  const reviewer = viewer === "reviewer";
  const isEditor = viewer === "editor";

  let sentence: React.ReactNode = null;
  let detail: React.ReactNode = null;
  let actions: React.ReactNode = null;
  let tone: "default" | "attention" | "danger" | "success" | "muted" = "default";
  /** The editor's send dialog (pinned bar only): the quoted request sits above the box. */
  let sendIntro: React.ReactNode = null;
  const openSend = (
    <Button leadingIcon={<Send aria-hidden="true" />} onClick={() => setSendOpen(true)}>
      Send for checking
    </Button>
  );

  switch (stage) {
    case "needs_editor": {
      if (reviewer && nextStep.allowed) {
        sentence = "Who should edit this?";
        actions = (
          <Button leadingIcon={<UserRoundPen aria-hidden="true" />} onClick={() => setAssignOpen(true)}>
            Assign editor
          </Button>
        );
      } else {
        sentence = shooter ? `Needs an editor · waiting on ${shooter}.` : "Needs an editor.";
      }
      break;
    }
    case "with_editor": {
      const editing = header.stage.subLabel === "editing";
      if (isEditor) {
        if (editing) {
          sentence = pinned ? "Done editing? Send it for checking." : "Paste where the finished photos are, then send for checking.";
          if (!nextStep.allowed) break;
          if (pinned) actions = openSend;
          else detail = <SendForCheckingForm jobId={header.id} version={header.version} lastLink={nextStep.lastFinishedLink} hasCurrentLink={nextStep.hasFinishedLink} checkerName={shooter} onConflict={onConflict} className="mt-3" />;
        } else {
          sentence = files.raw ? "Raw files are ready." : `No raw files link yet${shooter ? ` — ask ${shooter} for it` : ""}.`;
          actions = (
            <>
              <OpenLink link={files.raw} label="Open raw files" primary={!nextStep.allowed} />
              {nextStep.allowed ? <StartEditingButton jobId={header.id} version={header.version} onConflict={onConflict} variant={files.raw ? "outline" : "primary"} /> : null}
            </>
          );
        }
      } else {
        sentence = editor ? `${editing ? `${editor} is editing` : `Waiting on ${editor}`}${due ? ` · ${due}` : ""}.` : "Waiting on an editor.";
        if (reviewer && permissions.canChangeEditor) {
          actions = (
            <Button variant="outline" leadingIcon={<UserRoundPen aria-hidden="true" />} onClick={() => setAssignOpen(true)}>
              Change editor
            </Button>
          );
        }
      }
      break;
    }
    case "ready_to_check": {
      const ago = nextStep.sentAt ? agoWords(secondsBetween(nextStep.sentAt, now)) : null;
      tone = "attention";
      if (isEditor) {
        sentence = `Sent to ${shooter ?? "the photographer"} for checking. You'll be told if anything needs changing.`;
      } else if (reviewer && nextStep.allowed) {
        sentence = (
          <>
            {editor ?? "The editor"} sent this{ago ? ` ${ago}` : ""}.
            <RoundBadge round={header.round} className="ml-2 align-middle" />
          </>
        );
        if (!files.finished) detail = <p className="mt-1 text-sm text-ink-muted">No finished photos link was recorded with this send.</p>;
        actions = (
          <>
            <OpenLink link={files.finished} label="Open finished photos" iconOnly={pinned} />
            <ApproveButton
              jobId={header.id}
              version={header.version}
              clientName={header.client.name}
              shareQuestion={nextStep.shareQuestion}
              selfReviewNeedsConfirm={nextStep.selfReviewNeedsConfirm}
              shareableLinks={shareable(page)}
              finishedLink={toSimple(files.finished)}
              onConflict={onConflict}
            />
            <Button variant="outline" leadingIcon={<RotateCcw aria-hidden="true" />} onClick={() => setChangesOpen(true)}>
              Ask for changes
            </Button>
          </>
        );
      } else {
        sentence = `Sent for checking${ago ? ` ${ago}` : ""}. ${reviewer ? "The studio owner will check this." : `Waiting on ${shooter ?? "the photographer"}.`}`;
        actions = <OpenLink link={files.finished} label="Open finished photos" />;
      }
      break;
    }
    case "changes_asked": {
      tone = "danger";
      const req = latestRequest(page.changesAsked);
      if (isEditor) {
        sentence = `${req?.who.name ?? shooter ?? "The photographer"} asked for changes.`;
        if (pinned) {
          // One line + buttons; the request itself lives in the Changes asked section and in the send dialog.
          sendIntro = req ? <RequestNote req={req} timeZone={timeZone} className="mt-0" /> : null;
          actions = (
            <>
              <Button variant="outline" leadingIcon={<MessageSquareText aria-hidden="true" />} onClick={scrollToChangesAsked}>
                See request
              </Button>
              {nextStep.allowed ? openSend : null}
            </>
          );
        } else {
          detail = (
            <>
              {req ? <RequestNote req={req} timeZone={timeZone} /> : null}
              {nextStep.allowed ? (
                <SendForCheckingForm jobId={header.id} version={header.version} lastLink={nextStep.lastFinishedLink} hasCurrentLink={nextStep.hasFinishedLink} checkerName={req?.who.name ?? shooter} onConflict={onConflict} className="mt-3" />
              ) : null}
            </>
          );
        }
      } else {
        sentence = `Back with ${editor ?? "the editor"}${due ? ` · ${due}` : ""}.`;
        detail = req && !pinned ? <RequestNote req={req} timeZone={timeZone} compact /> : null;
      }
      break;
    }
    case "done": {
      tone = "success";
      sentence = doneSentence(page, timeZone);
      const notSent = header.stage.subLabel === "not_sent_to_client";
      if (reviewer) {
        actions = (
          <>
            {files.finished ? <CopyButton value={files.finished.url} label="Copy finished link" variant="outline" size="md" successMessage="Finished link copied" /> : null}
            {notSent && sideColumn.clientHasPortal ? <SendToClientButton jobId={header.id} version={header.version} clientName={header.client.name} shareableLinks={shareable(page)} onConflict={onConflict} /> : null}
          </>
        );
      }
      break;
    }
    case "cancelled": {
      tone = "muted";
      sentence = "This job was cancelled.";
      if (permissions.canRestore) actions = <RestoreButton jobId={header.id} version={header.version} onConflict={onConflict} />;
      break;
    }
  }

  const tones = {
    default: "border-border bg-surface",
    attention: "border-attention/30 bg-attention-soft/40",
    danger: "border-danger/25 bg-danger-soft/40",
    success: "border-success/25 bg-success-soft/40",
    muted: "border-border bg-surface-sunken",
  } as const;

  return (
    <section
      aria-label="Next step"
      data-stage={stage}
      // Pinned (phones): a compact bar (sentence + buttons), never more than ~30% of the screen, so Files and Messages stay reachable underneath (plan §5).
      className={cn("rounded-lg border shadow-xs", tones[tone], pinned ? "max-h-[30dvh] overflow-y-auto p-3" : "p-4 sm:p-5", className)}
    >
      {/* The sentence keeps at least ~16rem (8rem pinned); the buttons wrap underneath when there is no room beside it. */}
      <div className={cn("flex flex-wrap items-center justify-between", pinned ? "gap-x-3 gap-y-2" : "gap-x-6 gap-y-3")}>
        <div className={cn("min-w-0 flex-1", pinned ? "basis-32" : "basis-64")}>
          {!pinned ? <p className="eyebrow mb-1">Next step</p> : null}
          <p className={cn("font-medium text-ink", pinned ? "line-clamp-2 text-sm leading-5" : "text-md leading-6")}>{sentence}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 pointer-coarse:[&>*]:min-h-10">{actions}</div> : null}
      </div>
      {detail}

      <AssignEditorDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        jobId={header.id}
        version={header.version}
        mode={header.editedBy ? "change" : "assign"}
        currentEditorId={header.editedBy?.id ?? null}
        jobLabel={jobLabel}
        options={nextStep.editorOptions}
        onConflict={onConflict}
      />
      <AskForChangesDialog open={changesOpen} onOpenChange={setChangesOpen} jobId={header.id} version={header.version} editorName={editor} jobLabel={jobLabel} timeZone={timeZone} onConflict={onConflict} />
      {pinned && isEditor && nextStep.allowed ? (
        <SendForCheckingDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          jobId={header.id}
          version={header.version}
          lastLink={nextStep.lastFinishedLink}
          hasCurrentLink={nextStep.hasFinishedLink}
          checkerName={latestRequest(page.changesAsked)?.who.name ?? shooter}
          intro={sendIntro}
          onConflict={onConflict}
        />
      ) : null}
      {conflictDialog}
    </section>
  );
}

/**
 * The latest request, quoted (round, who, when, what). `compact` (the owner's card) keeps it
 * small and collapses the text to ONE line behind "Show request".
 */
export function RequestNote({ req, timeZone, compact = false, className }: { req: ChangesAskedRound; timeZone: string; compact?: boolean; className?: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const oneLine = compact && !expanded;
  return (
    <blockquote className={cn("mt-3 rounded-md border-l-4 border-danger/60 bg-surface px-3 py-2", compact && "text-sm", className)} data-request-note={oneLine ? "collapsed" : "open"}>
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
        <span className="font-semibold text-danger-fg">Round {req.round}</span>
        <span>{req.who.name}</span>
        <time dateTime={req.when} title={formatDateTime(req.when, timeZone)}>
          {formatDateShort(req.when, timeZone)}
        </time>
        {req.status === "open" ? <span className="rounded-full bg-danger-soft px-1.5 text-2xs font-medium text-danger-fg">Open</span> : null}
        {compact ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={!oneLine}
            className="ml-auto inline-flex items-center gap-0.5 rounded-xs font-medium text-ink-secondary hover:text-ink focus-ring"
          >
            {oneLine ? "Show request" : "Hide"}
            <ChevronDown aria-hidden="true" className={cn("size-3 transition-transform", !oneLine && "rotate-180")} />
          </button>
        ) : null}
      </p>
      <p className={cn("mt-1 whitespace-pre-wrap text-ink", oneLine ? "truncate whitespace-nowrap" : "")}>{req.what}</p>
    </blockquote>
  );
}
