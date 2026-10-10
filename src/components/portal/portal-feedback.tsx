"use client";

import * as React from "react";
import { MessageSquareText, Pencil, Send, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { RelativeTime } from "@/components/jobs/relative-time";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs/mutation";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { COMMENT_EDIT_WINDOW_MINUTES } from "@/lib/constants";
import type { PortalFeedbackMessage, PortalFeedbackThread } from "@/lib/types";

export interface PortalFeedbackProps {
  jobId: string;
  threads: PortalFeedbackThread[];
  canGiveFeedback: boolean;
  /** Why the composer is hidden (feedback off / cancelled). */
  disabledReason: string | null;
  /** Ids of messages the viewer wrote (edit / delete). */
  ownIds: string[];
  studioName: string;
  timeZone: string;
}

const MAX = 10_000;

function withinEditWindow(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() < COMMENT_EDIT_WINDOW_MINUTES * 60_000;
}

function Composer({
  label,
  placeholder,
  submitLabel,
  initial = "",
  autoFocus = false,
  rows = 3,
  onSubmit,
  onCancel,
}: {
  /** Accessible name of the textbox. */
  label: string;
  placeholder: string;
  rows?: number;
  submitLabel: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<string | null | true>;
  onCancel?: () => void;
}) {
  const [body, setBody] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();
  const trimmed = body.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || pending) return;
    setPending(true);
    const res = await onSubmit(trimmed);
    setPending(false);
    if (res === true) {
      setBody("");
      setError(null);
    } else setError(res);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Textarea
        id={id}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={MAX}
        autoFocus={autoFocus}
        invalid={Boolean(error)}
        aria-describedby={error ? `${id}-err` : undefined}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(e);
        }}
      />
      {error ? (
        <p id={`${id}-err`} className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" loading={pending} disabled={!trimmed} leadingIcon={<Send aria-hidden="true" />}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function Message({
  message,
  own,
  studioName,
  timeZone,
  onEdit,
  onDelete,
}: {
  message: PortalFeedbackMessage;
  own: boolean;
  studioName: string;
  timeZone: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const canChange = own && !message.deleted;
  const editable = canChange && withinEditWindow(message.createdAt);
  return (
    <div className="flex gap-3">
      <Avatar name={message.authorName || "?"} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-ink">{message.isClient ? message.authorName : message.authorName || studioName}</span>
          {!message.isClient ? (
            <Badge size="sm" variant="accent">
              {studioName}
            </Badge>
          ) : null}
          <RelativeTime value={message.createdAt} timeZone={timeZone} className="text-xs text-ink-muted" />
          {message.editedAt ? <span className="text-xs text-ink-subtle">(edited)</span> : null}
        </div>
        {message.deleted ? (
          <p className="mt-1 text-sm italic text-ink-subtle">This message was deleted.</p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-secondary">{message.body}</p>
        )}
        {canChange ? (
          <div className="mt-1 flex gap-1">
            {editable ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2" leadingIcon={<Pencil aria-hidden="true" />} onClick={onEdit}>
                Edit
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-ink-muted" leadingIcon={<Trash2 aria-hidden="true" />} onClick={onDelete}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Feedback threads on a shared job (docs/ROLES.md §7.5): the client starts a
 * thread, the studio replies, the client follows up. Bodies are plain text.
 */
export function PortalFeedback({ jobId, threads, canGiveFeedback, disabledReason, ownIds, studioName, timeZone }: PortalFeedbackProps) {
  const run = useMutationRunner();
  const own = React.useMemo(() => new Set(ownIds), [ownIds]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  async function post(body: string, parentCommentId?: string): Promise<string | null | true> {
    const res = await run(() => api.post(`/api/portal/jobs/${jobId}/feedback`, { body, ...(parentCommentId ? { parentCommentId } : {}) }), {
      success: parentCommentId ? "Reply sent" : "Feedback sent",
      successDescription: parentCommentId ? undefined : `${studioName} has been notified.`,
    });
    if (res.ok) return true;
    return firstFieldErrors(res.fieldErrors).body ?? null;
  }

  async function edit(id: string, body: string): Promise<string | null | true> {
    const res = await run(() => api.patch(`/api/portal/comments/${id}`, { body }), { success: "Message updated" });
    if (res.ok) {
      setEditing(null);
      return true;
    }
    return firstFieldErrors(res.fieldErrors).body ?? null;
  }

  async function remove(id: string) {
    await run(() => api.delete(`/api/portal/comments/${id}`), { success: "Message deleted" });
    setDeleting(null);
  }

  const renderMessage = (m: PortalFeedbackMessage) =>
    editing === m.id ? (
      <Composer
        key={m.id}
        label="Edit your message"
        placeholder="Edit your message"
        submitLabel="Save"
        initial={m.body}
        autoFocus
        onSubmit={(body) => edit(m.id, body)}
        onCancel={() => setEditing(null)}
      />
    ) : (
      <Message
        key={m.id}
        message={m}
        own={own.has(m.id)}
        studioName={studioName}
        timeZone={timeZone}
        onEdit={() => setEditing(m.id)}
        onDelete={() => setDeleting(m.id)}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this message?"
        description="The studio will see that a message was deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
      {threads.length === 0 ? (
        <EmptyState
          size="sm"
          bordered
          icon={MessageSquareText}
          title="No feedback yet"
          description={canGiveFeedback ? `Questions or changes? Write to ${studioName} below.` : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {threads.map((t) => (
            <li key={t.id} className="rounded-lg border border-border bg-surface p-4">
              {renderMessage(t)}
              {t.replies.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-3 border-l-2 border-border pl-4 sm:ml-3">
                  {t.replies.map((r) => (
                    <li key={r.id}>{renderMessage(r)}</li>
                  ))}
                </ul>
              ) : null}
              {canGiveFeedback ? (
                <div className="mt-3 border-t border-border pt-3">
                  <Composer label="Reply to this thread" placeholder="Write a reply…" submitLabel="Reply" rows={2} onSubmit={(body) => post(body, t.id)} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canGiveFeedback ? (
        <div className="rounded-lg border border-border bg-surface-sunken/60 p-4">
          <p className="mb-2 text-sm font-medium text-ink">{threads.length > 0 ? "Start a new conversation" : `Leave feedback for ${studioName}`}</p>
          <Composer
            label={`New feedback for ${studioName}`}
            placeholder="Ask a question or describe a change you'd like"
            submitLabel="Send feedback"
            onSubmit={(body) => post(body)}
          />
        </div>
      ) : disabledReason ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-ink-muted">{disabledReason}</p>
      ) : null}
    </div>
  );
}
