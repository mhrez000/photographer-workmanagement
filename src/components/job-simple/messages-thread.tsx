"use client";

import * as React from "react";
import { CornerDownRight, MessagesSquare, Reply, Send, Trash2 } from "lucide-react";
import { ConfirmDialog, SectionCard } from "@/components/common";
import { MentionTextarea } from "@/components/job-detail/mention-textarea";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { CommentNode, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface MessagesThreadProps {
  jobId: string;
  messages: CommentNode[];
  canComment: boolean;
  /** Comment ids the viewer may delete. */
  deletable: Record<string, boolean>;
  timeZone: string;
  viewerId: string | null;
  /** Who reads the thread, for the empty-state line ("Mo and Sam"). */
  participants?: string[];
  /** The viewer is the editor: the empty state invites them to ask the photographer, not "the editor". */
  viewerIsEditor?: boolean;
  /** The photographer's name, for the editor's wording. */
  photographerName?: string | null;
  className?: string;
}

/** The element id of the message composer (the ⋯ "Ask a question" item focuses it). */
export const MESSAGE_COMPOSER_ID = "message-composer";

/**
 * Scrolls to Messages, focuses the composer and outlines the card for a moment — what "Ask a
 * question" in the ⋯ menu does, so it visibly does something even when Messages is already in view.
 */
export function focusMessageComposer(): void {
  const card = document.getElementById("messages");
  const box = document.getElementById(MESSAGE_COMPOSER_ID);
  if (!card && !box) return;
  (box ?? card)?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (box instanceof HTMLTextAreaElement) box.focus({ preventScroll: true });
  if (card) {
    card.setAttribute("data-highlight", "");
    window.setTimeout(() => card.removeAttribute("data-highlight"), 1600);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Body({ body, mentions }: { body: string; mentions: UserRef[] }) {
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

function mentionedIn(body: string, picked: Map<string, UserRef>): string[] {
  return [...picked.values()].filter((u) => body.includes(`@${u.name}`)).map((u) => u.id);
}

interface ComposerProps {
  jobId: string;
  parent?: CommentNode | null;
  autoFocus?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
}

/** One box. A question is just a message; @ mentions someone who can see the job. */
function Composer({ jobId, parent = null, autoFocus = false, onDone, onCancel }: ComposerProps) {
  const run = useMutationRunner();
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const picked = React.useRef(new Map<string, UserRef>());

  const submit = async (event?: React.SyntheticEvent) => {
    event?.preventDefault();
    const text = body.trim();
    if (!text) {
      setError("Write something first.");
      return;
    }
    setBusy(true);
    const result = await run(
      () => api.post(`/api/jobs/${jobId}/comments`, { body: text, kind: "comment", parentCommentId: parent?.id ?? null, revisionId: parent?.revisionId ?? null, mentionUserIds: mentionedIn(text, picked.current) }),
      { success: parent ? "Reply sent" : "Message sent" },
    );
    setBusy(false);
    if (result.ok) {
      setBody("");
      picked.current.clear();
      setError(null);
      onDone?.();
    } else if (result.fieldErrors) {
      const f = firstFieldErrors(result.fieldErrors);
      setError(f.body ?? f.mentionUserIds ?? Object.values(f)[0] ?? null);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <MentionTextarea
        id={parent ? undefined : MESSAGE_COMPOSER_ID}
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
        autoFocus={autoFocus}
        placeholder={parent ? `Reply to ${parent.author.name}…` : "Write a message or ask a question — type @ to mention someone"}
        aria-label={parent ? `Reply to ${parent.author.name}` : "New message"}
        invalid={Boolean(error)}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" loading={busy} leadingIcon={<Send aria-hidden="true" />}>
          {parent ? "Reply" : "Send"}
        </Button>
      </div>
    </form>
  );
}

interface ItemProps {
  node: CommentNode;
  jobId: string;
  canComment: boolean;
  deletable: Record<string, boolean>;
  timeZone: string;
  viewerId: string | null;
  depth: number;
  onDelete: (node: CommentNode) => void;
}

function MessageItem({ node, jobId, canComment, deletable, timeZone, viewerId, depth, onDelete }: ItemProps) {
  const [replying, setReplying] = React.useState(false);
  const deleted = node.deletedAt !== null || node.body === null;
  const mine = node.author.id === viewerId;
  return (
    <li className={cn("relative", depth > 0 && "pl-6 sm:pl-8")}>
      {depth > 0 ? <CornerDownRight aria-hidden="true" className="absolute left-0 top-2 size-3.5 text-ink-subtle sm:left-2" /> : null}
      <div id={`comment-${node.id}`} className="flex gap-3 scroll-mt-40">
        <Avatar name={node.author.name} colour={node.author.avatarColour || undefined} size={depth > 0 ? "sm" : "md"} className={cn("mt-0.5 shrink-0", !node.author.isActive && "grayscale opacity-60")} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium text-ink">{mine ? "You" : node.author.name}</span>
            <time dateTime={node.createdAt} title={formatDateTime(node.createdAt, timeZone)} className="text-xs text-ink-subtle numeric" suppressHydrationWarning>
              {formatRelative(node.createdAt)}
            </time>
            {node.editedAt && !deleted ? <span className="text-2xs text-ink-subtle">(edited)</span> : null}
          </p>
          {deleted ? (
            <p className="mt-0.5 text-sm italic text-ink-subtle">This message was deleted.</p>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-secondary">
              <Body body={node.body ?? ""} mentions={node.mentions} />
            </p>
          )}
          {!deleted ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-3">
              {canComment ? (
                <button type="button" onClick={() => setReplying((r) => !r)} className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-ink-muted hover:text-ink focus-ring">
                  <Reply aria-hidden="true" className="size-3.5" /> Reply
                </button>
              ) : null}
              {deletable[node.id] ? (
                <button type="button" onClick={() => onDelete(node)} className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-ink-muted hover:text-danger focus-ring">
                  <Trash2 aria-hidden="true" className="size-3.5" /> Delete
                </button>
              ) : null}
            </div>
          ) : null}
          {replying ? (
            <div className="mt-2">
              <Composer jobId={jobId} parent={node} autoFocus onDone={() => setReplying(false)} onCancel={() => setReplying(false)} />
            </div>
          ) : null}
        </div>
      </div>
      {node.replies.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-3">
          {node.replies.map((r) => (
            <MessageItem key={r.id} node={r} jobId={jobId} canComment={canComment} deletable={deletable} timeZone={timeZone} viewerId={viewerId} depth={Math.min(depth + 1, 2)} onDelete={onDelete} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Messages (plan §5): one thread between the owner, photographers and the
 * editor, with @mentions. Oldest first, like a chat; the composer sits at the
 * bottom. Private notes never appear here.
 */
export function MessagesThread({ jobId, messages, canComment, deletable, timeZone, viewerId, participants = [], viewerIsEditor = false, photographerName = null, className }: MessagesThreadProps) {
  const run = useMutationRunner();
  const [toDelete, setToDelete] = React.useState<CommentNode | null>(null);
  const threads = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const who = participants.length > 0 ? participants.join(", ") : "the people on this job";
  const invite = !canComment ? "" : viewerIsEditor ? ` Ask ${photographerName ?? "the photographer"} anything about this job.` : " Ask a question or leave a note for the editor.";

  return (
    <SectionCard
      id="messages"
      title="Messages"
      description={`Between ${who}. The client never sees these.`}
      className={cn("rounded-lg transition-shadow duration-(--motion-slow) data-[highlight]:shadow-[0_0_0_3px_var(--accent)]", className)}
    >
      {threads.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <MessagesSquare aria-hidden="true" className="size-4" />
          No messages yet.{invite}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {threads.map((t) => (
            <MessageItem key={t.id} node={t} jobId={jobId} canComment={canComment} deletable={deletable} timeZone={timeZone} viewerId={viewerId} depth={0} onDelete={setToDelete} />
          ))}
        </ul>
      )}
      {canComment ? (
        <div className={cn("border-t border-border pt-4", threads.length > 0 ? "mt-5" : "mt-4")}>
          <Composer jobId={jobId} />
        </div>
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => (!open ? setToDelete(null) : undefined)}
        title="Delete this message?"
        description="Everyone sees a “deleted” placeholder instead. The original text stays in the history."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!toDelete) return false;
          const result = await run(() => api.delete(`/api/comments/${toDelete.id}`), { success: "Message deleted" });
          return result.ok ? undefined : false;
        }}
      />
    </SectionCard>
  );
}
