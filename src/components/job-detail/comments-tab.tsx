"use client";

import * as React from "react";
import { CircleHelp, Clock3, CornerDownRight, MessageSquareDashed, MessagesSquare, Pencil, Reply, RotateCcw, Send, Trash2, type LucideIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/common";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/hooks";
import { api } from "@/lib/api-client";
import { COMMENT_EDIT_WINDOW_MINUTES, COMMENT_KINDS, type CommentKind } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { CommentNode, RevisionView, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MentionTextarea } from "./mention-textarea";

const KIND_META: Record<CommentKind, { label: string; icon: LucideIcon | null; variant: "neutral" | "info" | "warning" | "danger" }> = {
  comment: { label: "Comment", icon: null, variant: "neutral" },
  question: { label: "Question", icon: CircleHelp, variant: "info" },
  clarification_request: { label: "Clarification request", icon: MessageSquareDashed, variant: "warning" },
  revision_response: { label: "Revision response", icon: RotateCcw, variant: "danger" },
};

export interface CommentsTabProps {
  jobId: string;
  comments: CommentNode[];
  revisions: RevisionView[];
  canComment: boolean;
  /** Comment ids the viewer may (soft) delete. */
  deletable: Record<string, boolean>;
  timeZone: string;
  /** `?respond=<revisionId>`: start a revision response. */
  respondTo?: string | null;
  /** `?compose=1` ("c" shortcut): focus the composer. */
  autoFocus?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Body with @mention highlighting                                     */
/* ------------------------------------------------------------------ */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function CommentBody({ body, mentions }: { body: string; mentions: UserRef[] }) {
  if (mentions.length === 0) return <>{body}</>;
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length).map((m) => escapeRegExp(m.name));
  const re = new RegExp(`@(${names.join("|")})`, "g");
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(body.slice(last, idx));
    parts.push(
      <mark key={idx} className="rounded-xs bg-accent-soft px-0.5 font-medium text-accent-ink">
        {m[0]}
      </mark>,
    );
    last = idx + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <>{parts}</>;
}

/** Mentioned users still present in the text (removed "@Name"s are dropped). */
function mentionedIn(body: string, picked: Map<string, UserRef>): string[] {
  return [...picked.values()].filter((u) => body.includes(`@${u.name}`)).map((u) => u.id);
}

/* ------------------------------------------------------------------ */
/*  Composer                                                            */
/* ------------------------------------------------------------------ */

interface ComposerProps {
  jobId: string;
  revisions: RevisionView[];
  parent?: CommentNode | null;
  initialKind?: CommentKind;
  initialRevisionId?: string | null;
  autoFocus?: boolean;
  id?: string;
  onDone?: () => void;
  onCancel?: () => void;
}

function Composer({ jobId, revisions, parent = null, initialKind = "comment", initialRevisionId = null, autoFocus = false, id, onDone, onCancel }: ComposerProps) {
  const run = useMutationRunner();
  const [body, setBody] = React.useState("");
  const [kind, setKind] = React.useState<CommentKind>(parent?.kind === "revision_response" ? "revision_response" : initialKind);
  const [revisionId, setRevisionId] = React.useState<string>(parent?.revisionId ?? initialRevisionId ?? revisions.find((r) => r.isOpen)?.id ?? revisions[revisions.length - 1]?.id ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const picked = React.useRef(new Map<string, UserRef>());
  const ref = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async (event?: React.SyntheticEvent) => {
    event?.preventDefault();
    const text = body.trim();
    if (!text) {
      setError("Write something first.");
      return;
    }
    setBusy(true);
    const payload = {
      body: text,
      kind,
      parentCommentId: parent?.id ?? null,
      revisionId: kind === "revision_response" && revisionId ? revisionId : (parent?.revisionId ?? null),
      mentionUserIds: mentionedIn(text, picked.current),
    };
    const result = await run(() => api.post(`/api/jobs/${jobId}/comments`, payload), { success: parent ? "Reply posted" : "Comment posted" });
    setBusy(false);
    if (result.ok) {
      setBody("");
      setError(null);
      picked.current.clear();
      onDone?.();
    } else if (result.fieldErrors) {
      const f = firstFieldErrors(result.fieldErrors);
      setError(f.body ?? f.mentionUserIds ?? Object.values(f)[0] ?? null);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <MentionTextarea
        ref={ref}
        id={id}
        jobId={jobId}
        value={body}
        onValueChange={(v) => {
          setBody(v);
          if (error) setError(null);
        }}
        onMention={(u) => picked.current.set(u.id, u)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(e);
          if (e.key === "Escape" && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
        rows={parent ? 2 : 3}
        placeholder={parent ? `Reply to ${parent.author.name}…` : "Write a comment — type @ to mention someone who can see this job"}
        aria-label={parent ? `Reply to ${parent.author.name}` : "New comment"}
        invalid={Boolean(error)}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {!parent ? (
            <Select
              size="sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as CommentKind)}
              aria-label="Comment type"
              wrapperClassName="w-auto"
              options={COMMENT_KINDS.filter((k) => k !== "revision_response" || revisions.length > 0).map((k) => ({ value: k, label: KIND_META[k].label }))}
            />
          ) : null}
          {kind === "revision_response" && !parent && revisions.length > 0 ? (
            <Select
              size="sm"
              value={revisionId}
              onChange={(e) => setRevisionId(e.target.value)}
              aria-label="Revision"
              wrapperClassName="w-auto"
              options={[...revisions].reverse().map((r) => ({ value: r.id, label: `Revision #${r.revisionNumber} — ${r.reason}${r.isOpen ? " (open)" : ""}` }))}
            />
          ) : null}
          <span className="hidden text-2xs text-ink-subtle sm:inline">⌘/Ctrl + Enter to send</span>
        </div>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" loading={busy} leadingIcon={<Send aria-hidden="true" />}>
            {parent ? "Reply" : "Post"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  One comment                                                         */
/* ------------------------------------------------------------------ */

function EditWindow({ createdAt }: { createdAt: string }) {
  const now = useNow(15_000);
  if (now === null) return null;
  const left = Math.ceil((Date.parse(createdAt) + COMMENT_EDIT_WINDOW_MINUTES * 60_000 - now) / 60_000);
  if (left <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-ink-subtle" title={`Comments can be edited for ${COMMENT_EDIT_WINDOW_MINUTES} minutes after posting`}>
      <Clock3 aria-hidden="true" className="size-3" />
      editable for {left} more min
    </span>
  );
}

function useStillEditable(createdAt: string, canEdit: boolean): boolean {
  const now = useNow(15_000);
  if (!canEdit) return false;
  if (now === null) return true;
  return now < Date.parse(createdAt) + COMMENT_EDIT_WINDOW_MINUTES * 60_000;
}

interface CommentItemProps {
  node: CommentNode;
  jobId: string;
  revisions: RevisionView[];
  revisionLabel: (id: string | null) => string | null;
  canComment: boolean;
  deletable: Record<string, boolean>;
  timeZone: string;
  depth: number;
  onDelete: (node: CommentNode) => void;
}

function CommentItem({ node, jobId, revisions, revisionLabel, canComment, deletable, timeZone, depth, onDelete }: CommentItemProps) {
  const run = useMutationRunner();
  const [replying, setReplying] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(node.body ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const editable = useStillEditable(node.createdAt, node.canEdit);
  const meta = KIND_META[node.kind];
  const deleted = node.deletedAt !== null || node.body === null;
  const revLabel = revisionLabel(node.revisionId);

  const save = async (event?: React.SyntheticEvent) => {
    event?.preventDefault();
    if (!draft.trim()) {
      setError("A comment cannot be empty.");
      return;
    }
    setBusy(true);
    const result = await run(() => api.patch(`/api/comments/${node.id}`, { body: draft.trim() }), { success: "Comment updated" });
    setBusy(false);
    if (result.ok) setEditing(false);
    else if (result.fieldErrors) setError(firstFieldErrors(result.fieldErrors).body ?? "Please check the comment.");
  };

  return (
    <li className={cn("relative", depth > 0 && "pl-5 sm:pl-7")}>
      {depth > 0 ? <CornerDownRight aria-hidden="true" className="absolute left-0 top-2.5 size-3.5 text-ink-subtle sm:left-1.5" /> : null}
      <div id={`comment-${node.id}`} className="flex gap-3 scroll-mt-40">
        <Avatar name={node.author.name} colour={node.author.avatarColour || undefined} size={depth > 0 ? "sm" : "md"} className={cn("mt-0.5 shrink-0", !node.author.isActive && "grayscale opacity-60")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-ink">{node.author.name}</span>
            {node.kind !== "comment" ? (
              <Badge variant={meta.variant} size="sm">
                {meta.icon ? <meta.icon aria-hidden="true" /> : null}
                {meta.label}
                {revLabel ? ` · ${revLabel}` : ""}
              </Badge>
            ) : revLabel ? (
              <Badge variant="outline" size="sm">
                {revLabel}
              </Badge>
            ) : null}
            <time dateTime={node.createdAt} title={formatDateTime(node.createdAt, timeZone)} className="text-xs text-ink-subtle numeric" suppressHydrationWarning>
              {formatRelative(node.createdAt)}
            </time>
            {node.editedAt && !deleted ? (
              <span className="text-2xs text-ink-subtle" title={`Edited ${formatDateTime(node.editedAt, timeZone)}`}>
                (edited{node.editCount > 1 ? ` ×${node.editCount}` : ""})
              </span>
            ) : null}
          </div>

          {deleted ? (
            <p className="mt-1 text-sm italic text-ink-subtle">This comment was deleted{node.deletedAt ? ` · ${formatDateTime(node.deletedAt, timeZone)}` : ""}.</p>
          ) : editing ? (
            <form onSubmit={save} className="mt-1.5 flex flex-col gap-2">
              <Textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save(e);
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
                rows={3}
                autoFocus
                aria-label="Edit comment"
                invalid={Boolean(error)}
              />
              {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
              <div className="flex items-center justify-between gap-2">
                <EditWindow createdAt={node.createdAt} />
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft(node.body ?? ""); }}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" loading={busy}>
                    Save
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-secondary">
              <CommentBody body={node.body ?? ""} mentions={node.mentions} />
            </p>
          )}

          {!deleted && !editing ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {canComment ? (
                <button type="button" onClick={() => setReplying((r) => !r)} className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-ink-muted hover:text-ink focus-ring">
                  <Reply aria-hidden="true" className="size-3.5" /> Reply
                </button>
              ) : null}
              {editable ? (
                <>
                  <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-ink-muted hover:text-ink focus-ring">
                    <Pencil aria-hidden="true" className="size-3.5" /> Edit
                  </button>
                  <EditWindow createdAt={node.createdAt} />
                </>
              ) : null}
              {deletable[node.id] ? (
                <button type="button" onClick={() => onDelete(node)} className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-ink-muted hover:text-danger focus-ring">
                  <Trash2 aria-hidden="true" className="size-3.5" /> Delete
                </button>
              ) : null}
            </div>
          ) : null}

          {replying ? (
            <div className="mt-3">
              <Composer jobId={jobId} revisions={revisions} parent={node} autoFocus onDone={() => setReplying(false)} onCancel={() => setReplying(false)} />
            </div>
          ) : null}
        </div>
      </div>

      {node.replies.length > 0 ? (
        <ul className={cn("mt-4 flex flex-col gap-4", depth === 0 && "border-l border-border/80 ml-4 sm:ml-5")}>
          {node.replies.map((r) => (
            <CommentItem
              key={r.id}
              node={r}
              jobId={jobId}
              revisions={revisions}
              revisionLabel={revisionLabel}
              canComment={canComment}
              deletable={deletable}
              timeZone={timeZone}
              depth={Math.min(depth + 1, 3)}
              onDelete={onDelete}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab                                                                 */
/* ------------------------------------------------------------------ */

function latestActivity(node: CommentNode): string {
  return node.replies.reduce((max, r) => {
    const l = latestActivity(r);
    return l > max ? l : max;
  }, node.createdAt);
}

/** Threaded comments (permanent): kinds, replies, @mentions, revision responses. */
export function CommentsTab({ jobId, comments, revisions, canComment, deletable, timeZone, respondTo, autoFocus }: CommentsTabProps) {
  const run = useMutationRunner();
  const [toDelete, setToDelete] = React.useState<CommentNode | null>(null);
  const respondRevision = respondTo ? revisions.find((r) => r.id === respondTo) ?? null : null;
  const threads = [...comments].sort((a, b) => latestActivity(b).localeCompare(latestActivity(a)));
  const revisionLabel = React.useCallback(
    (id: string | null) => {
      if (!id) return null;
      const r = revisions.find((x) => x.id === id);
      return r ? `Revision #${r.revisionNumber}` : null;
    },
    [revisions],
  );

  return (
    <div className="flex flex-col gap-5">
      {canComment ? (
        <Card className={cn("p-4", respondRevision && "border-status-revision/30")}>
          {respondRevision ? (
            <p className="mb-3 flex items-center gap-2 text-sm text-ink-secondary">
              <RotateCcw aria-hidden="true" className="size-4 text-status-revision" />
              Responding to <strong className="font-medium text-ink">Revision #{respondRevision.revisionNumber} — {respondRevision.reason}</strong>
            </p>
          ) : null}
          <Composer
            id="comment-composer"
            jobId={jobId}
            revisions={revisions}
            initialKind={respondRevision ? "revision_response" : "comment"}
            initialRevisionId={respondRevision?.id ?? null}
            autoFocus={Boolean(autoFocus || respondRevision)}
          />
        </Card>
      ) : (
        <p className="rounded-md border border-dashed border-border bg-surface-sunken/60 px-4 py-3 text-sm text-ink-muted">
          You can read this conversation but not post to it.
        </p>
      )}

      {threads.length === 0 ? (
        <Card>
          <EmptyState
            icon={MessagesSquare}
            title="No comments yet"
            description={canComment ? "Ask a question, request a clarification or leave context for the team. Comments are kept permanently with the job." : "Questions and updates about this job will appear here."}
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {threads.map((t) => (
            <li key={t.id}>
              <Card className="p-4 sm:p-5">
                <ul>
                  <CommentItem
                    node={t}
                    jobId={jobId}
                    revisions={revisions}
                    revisionLabel={revisionLabel}
                    canComment={canComment}
                    deletable={deletable}
                    timeZone={timeZone}
                    depth={0}
                    onDelete={setToDelete}
                  />
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => (!open ? setToDelete(null) : undefined)}
        title="Delete this comment?"
        description="The comment is replaced by a “deleted” placeholder for everyone. The original text stays in the audit log."
        confirmLabel="Delete comment"
        destructive
        onConfirm={async () => {
          if (!toDelete) return false;
          const result = await run(() => api.delete(`/api/comments/${toDelete.id}`), { success: "Comment deleted" });
          return result.ok ? undefined : false;
        }}
      />
    </div>
  );
}
