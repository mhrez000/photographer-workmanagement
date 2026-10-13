"use client";

import * as React from "react";
import { Building2, Reply, Send } from "lucide-react";
import { SectionCard } from "@/components/common";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { formatDateShort, formatDateTime, formatRelative } from "@/lib/dates";
import type { CommentNode, NoteView } from "@/lib/types";

export interface FromClientProps {
  jobId: string;
  clientName: string;
  threads: CommentNode[];
  /** What the client was told with the finished work (delivery notes) — shown here, never as editor instructions. */
  deliveryNotes?: NoteView[];
  canReply: boolean;
  timeZone: string;
  className?: string;
}

function ReplyBox({ jobId, root, onDone }: { jobId: string; root: CommentNode; onDone: () => void }) {
  const run = useMutationRunner();
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) {
      setError("Write the reply first.");
      return;
    }
    setBusy(true);
    const result = await run(() => api.post(`/api/jobs/${jobId}/comments`, { body: text, kind: "client_feedback", parentCommentId: root.id, mentionUserIds: [] }), { success: "Reply sent to the client" });
    setBusy(false);
    if (result.ok) onDone();
    else if (result.fieldErrors) setError(firstFieldErrors(result.fieldErrors).body ?? "Please check the reply.");
  };
  return (
    <form onSubmit={submit} noValidate className="mt-2 flex flex-col gap-2">
      <Textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          if (error) setError(null);
        }}
        rows={2}
        maxLength={5000}
        placeholder="The client will see this in their portal."
        aria-label="Reply to client"
        autoFocus
        invalid={Boolean(error)}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={busy} leadingIcon={<Send aria-hidden="true" />}>
          Send reply
        </Button>
      </div>
    </form>
  );
}

function Line({ node, timeZone, isClient }: { node: CommentNode; timeZone: string; isClient: boolean }) {
  const deleted = node.deletedAt !== null || node.body === null;
  return (
    <div className="flex gap-3">
      <Avatar name={node.author.name} colour={node.author.avatarColour || undefined} size="sm" shape={isClient ? "rounded" : "circle"} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-ink">{node.author.name}</span>
          {isClient ? <span className="text-2xs text-ink-subtle">client</span> : null}
          <time dateTime={node.createdAt} title={formatDateTime(node.createdAt, timeZone)} className="text-xs text-ink-subtle numeric" suppressHydrationWarning>
            {formatRelative(node.createdAt)}
          </time>
        </p>
        <p className={deleted ? "mt-0.5 text-sm italic text-ink-subtle" : "mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-secondary"}>{deleted ? "This message was deleted." : node.body}</p>
      </div>
    </div>
  );
}

/**
 * From the client (plan §5): the portal client's feedback, with [Reply to client], plus what they were
 * told with the finished work. Staff only; shown once the client can see the job.
 */
export function FromClient({ jobId, clientName, threads, deliveryNotes = [], canReply, timeZone, className }: FromClientProps) {
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const ordered = [...threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const told = [...deliveryNotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <SectionCard id="from-client" title={`From ${clientName}`} description="What the client said in their portal. Replies go back to them." className={className}>
      {told.length > 0 ? (
        <ul className="mb-4 flex flex-col gap-2 rounded-md border border-border bg-surface-sunken/60 px-3 py-2.5" aria-label="What the client was told">
          {told.map((n) => (
            <li key={n.id} className="text-sm">
              <p className="text-xs text-ink-muted">
                Told to the client by {n.author.name} ·{" "}
                <time dateTime={n.createdAt} title={formatDateTime(n.createdAt, timeZone)}>
                  {formatDateShort(n.createdAt, timeZone)}
                </time>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-secondary">{n.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {ordered.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Building2 aria-hidden="true" className="size-4" />
          Nothing from the client yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-5">
          {ordered.map((root) => (
            <li key={root.id} className="flex flex-col gap-3">
              <Line node={root} timeZone={timeZone} isClient={root.author.role === "client"} />
              {root.replies.length > 0 ? (
                <ul className="flex flex-col gap-3 border-l border-border pl-4 sm:ml-4">
                  {root.replies.map((r) => (
                    <li key={r.id}>
                      <Line node={r} timeZone={timeZone} isClient={r.author.role === "client"} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {canReply ? (
                replyTo === root.id ? (
                  <ReplyBox jobId={jobId} root={root} onDone={() => setReplyTo(null)} />
                ) : (
                  <Button variant="outline" size="sm" leadingIcon={<Reply aria-hidden="true" />} onClick={() => setReplyTo(root.id)} className="self-start">
                    Reply to client
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
