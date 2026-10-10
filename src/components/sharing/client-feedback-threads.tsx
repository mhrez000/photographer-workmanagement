"use client";

import * as React from "react";
import { ClipboardList, MessageSquareText, Reply, Send, TriangleAlert } from "lucide-react";
import { RelativeTime } from "@/components/jobs/relative-time";
import { RevisionRequestDialog } from "@/components/jobs/revision-request-dialog";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api-client";
import type { SharingFeedbackMessage, SharingFeedbackThread } from "@/lib/sharing";
import type { UserRef } from "@/lib/types";

export interface ClientFeedbackThreadsProps {
  jobId: string;
  jobNumber: string;
  jobVersion: number;
  editor: UserRef | null;
  clientName: string;
  threads: SharingFeedbackThread[];
  canReply: boolean;
  canTurnIntoRevision: boolean;
  timeZone: string;
}

function MessageRow({ m, clientName, timeZone }: { m: SharingFeedbackMessage; clientName: string; timeZone: string }) {
  return (
    <div className="flex gap-2.5">
      <Avatar name={m.authorName || "?"} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-ink">{m.authorName}</span>
          {m.isClient ? (
            <Badge size="sm" variant="outline">
              Client · {clientName}
            </Badge>
          ) : null}
          <RelativeTime value={m.createdAt} timeZone={timeZone} className="text-xs text-ink-muted" />
          {m.editedAt ? <span className="text-xs text-ink-subtle">(edited)</span> : null}
        </div>
        {m.deleted || m.body === null ? (
          <p className="mt-0.5 text-sm italic text-ink-subtle">Message deleted.</p>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink-secondary">{m.body}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Client feedback threads on the staff side (docs/ROLES.md §7.5, §11):
 * client threads with a "Client" badge, replies that the client sees, and
 * "Turn into revision request". Staff never start a client thread.
 */
export function ClientFeedbackThreads({
  jobId,
  jobNumber,
  jobVersion,
  editor,
  clientName,
  threads,
  canReply,
  canTurnIntoRevision,
  timeZone,
}: ClientFeedbackThreadsProps) {
  const run = useMutationRunner();
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [revisionOpen, setRevisionOpen] = React.useState(false);

  async function sendReply(threadId: string) {
    const text = body.trim();
    if (!text) return;
    setPending(true);
    const res = await run(
      () => api.post(`/api/jobs/${jobId}/comments`, { body: text, kind: "client_feedback", parentCommentId: threadId, mentionUserIds: [] }),
      { success: "Reply sent", successDescription: `${clientName} can see it in their portal.` },
    );
    setPending(false);
    if (res.ok) {
      setBody("");
      setReplyTo(null);
      setError(null);
    } else setError(firstFieldErrors(res.fieldErrors).body ?? null);
  }

  async function turnIntoRevision(t: SharingFeedbackThread) {
    const quote = [t, ...t.replies]
      .filter((m) => m.isClient && !m.deleted && m.body)
      .map((m) => `> ${m.body?.replace(/\n/g, "\n> ")}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(`Client feedback (${clientName}):\n${quote}`);
      toast.success("Client feedback copied", "Paste it into the revision request.");
    } catch {
      // clipboard blocked: the dialog still opens
    }
    setRevisionOpen(true);
  }

  if (threads.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-muted">
        <MessageSquareText aria-hidden="true" className="size-4" />
        No client feedback on this job.
      </p>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
        {threads.map((t) => (
          <li key={t.id} className="rounded-lg border border-border bg-surface p-3">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {t.waiting ? (
                <Badge size="sm" variant="attention" dot>
                  Waiting for a reply
                </Badge>
              ) : null}
              {t.fromOtherClient ? (
                <Badge size="sm" variant="neutral">
                  From a previous client — not visible to {clientName}
                </Badge>
              ) : null}
            </div>
            <MessageRow m={t} clientName={clientName} timeZone={timeZone} />
            {t.replies.length > 0 ? (
              <ul className="mt-2.5 flex flex-col gap-2.5 border-l-2 border-border pl-3">
                {t.replies.map((r) => (
                  <li key={r.id}>
                    <MessageRow m={r} clientName={clientName} timeZone={timeZone} />
                  </li>
                ))}
              </ul>
            ) : null}
            {!t.fromOtherClient && (canReply || canTurnIntoRevision) ? (
              replyTo === t.id ? (
                <form
                  className="mt-3 flex flex-col gap-2 border-t border-border pt-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendReply(t.id);
                  }}
                >
                  <p className="flex items-center gap-1.5 text-xs font-medium text-attention-fg">
                    <TriangleAlert aria-hidden="true" className="size-3.5" />
                    Your reply is visible to the client.
                  </p>
                  <label className="sr-only" htmlFor={`reply-${t.id}`}>
                    Reply to {clientName}
                  </label>
                  <Textarea
                    id={`reply-${t.id}`}
                    rows={3}
                    value={body}
                    autoFocus
                    invalid={Boolean(error)}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={`Reply to ${clientName}`}
                    maxLength={10_000}
                  />
                  {error ? <p className="text-sm text-danger-fg">{error}</p> : null}
                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setReplyTo(null)} disabled={pending}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" loading={pending} disabled={!body.trim()} leadingIcon={<Send aria-hidden="true" />}>
                      Send to client
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1">
                  {canReply ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      leadingIcon={<Reply aria-hidden="true" />}
                      onClick={() => {
                        setReplyTo(t.id);
                        setBody("");
                        setError(null);
                      }}
                    >
                      Reply
                    </Button>
                  ) : null}
                  {canTurnIntoRevision ? (
                    <Button type="button" size="sm" variant="ghost" leadingIcon={<ClipboardList aria-hidden="true" />} onClick={() => void turnIntoRevision(t)}>
                      Turn into revision request
                    </Button>
                  ) : null}
                </div>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {canTurnIntoRevision ? (
        <RevisionRequestDialog
          open={revisionOpen}
          onOpenChange={setRevisionOpen}
          jobId={jobId}
          version={jobVersion}
          jobLabel={jobNumber}
          currentEditor={editor}
          timeZone={timeZone}
        />
      ) : null}
    </>
  );
}
