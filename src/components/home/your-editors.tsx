import Link from "next/link";
import { ArrowRight, MailQuestion, WandSparkles } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import type { HomeEditorRow, PendingEditor } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface YourEditorsSectionProps {
  rows: HomeEditorRow[];
  /** Invited editors who have not opened their link yet: listed greyed, never counted, never assignable. */
  pending?: PendingEditor[];
  canInvite: boolean;
}

function Number_({ label, value, tone = "neutral", title }: { label: string; value: string; tone?: "neutral" | "danger" | "attention"; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-sm" title={title}>
      <span className="text-ink-muted">{label}</span>
      <span className={cn("numeric font-semibold", tone === "danger" ? "text-danger-fg" : tone === "attention" ? "text-attention-fg" : "text-ink")}>{value}</span>
    </span>
  );
}

/** Names that appear more than once in a list (lower-cased, trimmed) — those rows get the email as a second line. */
export function sharedNames(names: readonly string[]): Set<string> {
  const seen = new Map<string, number>();
  for (const n of names) {
    const key = n.trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key));
}

/**
 * "Your editors" — one row per JOINED editor: On their desk · Late (red) · On time this month
 * (docs/SIMPLIFICATION-PLAN.md §6, §7). Clicking a row opens that editor's page. Owners only.
 * Invited editors who have not joined yet sit under the list as "Invite pending · not joined yet" with
 * their email (front door), so the owner never hands a job to a ghost.
 */
export function YourEditorsSection({ rows, pending = [], canInvite }: YourEditorsSectionProps) {
  const duplicates = sharedNames([...rows.map((r) => r.editor.name), ...pending.map((p) => p.name)]);
  const pendingList =
    pending.length > 0 ? (
      <ul className="divide-y divide-border border-t border-border bg-surface-sunken/40" aria-label="Invites pending" data-pending-editors="">
        {pending.map((p) => (
          <li key={p.id}>
            <Link href={`/settings/people/${p.id}`} className="flex flex-col gap-1 px-5 py-2.5 transition-colors hover:bg-surface-muted/60 focus-ring sm:flex-row sm:items-center sm:justify-between" data-pending-editor={p.id}>
              <span className="flex min-w-0 items-center gap-3">
                <Avatar name={p.name} size="md" className="opacity-50 grayscale" />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-muted">{p.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{p.email}</span>
                </span>
              </span>
              <Badge variant="neutral" size="sm" className="shrink-0 self-start sm:self-auto">
                Invite pending · not joined yet
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    ) : null;

  return (
    <SectionCard
      id="your-editors"
      title="Your editors"
      flush
      footer={
        rows.length > 0 ? (
          <Link href="/editors" className="inline-flex items-center gap-1 font-medium text-ink-secondary hover:text-ink focus-ring rounded-xs">
            All five numbers
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={pending.length > 0 ? MailQuestion : WandSparkles}
          title={pending.length > 0 ? "No one has joined yet" : "No editors yet"}
          description={
            pending.length > 0
              ? "Your invite is out. Once they open their link and choose a password, their numbers appear here and you can give them jobs."
              : "Invite an editor and give them a job; their numbers appear here."
          }
          action={
            canInvite ? (
              <Button size="sm" variant="outline" href="/settings/people?invite=editor">
                {pending.length > 0 ? "Invite another editor" : "Invite an editor"}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.editor.id}>
              <Link
                href={`/editors/${row.editor.id}`}
                className="flex flex-col gap-2 px-5 py-3 transition-colors hover:bg-surface-muted/60 focus-ring sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar name={row.editor.name} size="md" colour={row.editor.avatarColour || undefined} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{row.editor.name}</span>
                    {duplicates.has(row.editor.name.trim().toLowerCase()) ? <span className="block truncate text-xs text-ink-muted">{row.email}</span> : null}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-x-5 gap-y-1 sm:justify-end">
                  <Number_
                    label="On their desk"
                    value={row.usualCapacity ? `${row.onDesk} of ${row.usualCapacity}` : String(row.onDesk)}
                    tone={row.full ? "attention" : "neutral"}
                    title="Jobs they have right now (With editor + Changes asked)"
                  />
                  <Number_ label="Late" value={String(row.lateNow)} tone={row.lateNow > 0 ? "danger" : "neutral"} title="Of those, past the due date" />
                  <Number_
                    label="On time this month"
                    value={row.notEnough || row.onTimePctThisMonth === null ? "Not enough jobs yet" : `${row.onTimePctThisMonth}%`}
                    title="Finished jobs they first sent for checking on or before the due date"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {pendingList}
    </SectionCard>
  );
}
