import Link from "next/link";
import { ArrowRight, WandSparkles } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import type { HomeEditorRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface YourEditorsSectionProps {
  rows: HomeEditorRow[];
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

/**
 * "Your editors" — one row per editor: On their desk · Late (red) · On time this month
 * (docs/SIMPLIFICATION-PLAN.md §6, §7). Clicking a row opens that editor's page. Owners only.
 */
export function YourEditorsSection({ rows, canInvite }: YourEditorsSectionProps) {
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
          icon={WandSparkles}
          title="No editors yet"
          description="Invite an editor and give them a job; their numbers appear here."
          action={
            canInvite ? (
              <Button size="sm" variant="outline" href="/settings/people?invite=1">
                Invite an editor
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
                  <span className="truncate font-medium text-ink">{row.editor.name}</span>
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
    </SectionCard>
  );
}
