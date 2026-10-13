import * as React from "react";
import { SectionCard } from "@/components/common";
import { civilDayMonth, civilWeekday } from "@/components/jobs-list/format";
import { civilDate } from "@/lib/dates";
import type { SimpleSideColumn } from "@/lib/types";
import { ShareProgressButton } from "./share-progress-button";

export interface SideColumnProps {
  side: SimpleSideColumn;
  timeZone: string;
  /** For the "Share progress" action on "Client can see this job". */
  jobId: string;
  version: number;
  clientName: string;
  /** The viewer may share the job with the portal client (owners / photographers; the client has a portal). */
  canShare: boolean;
  className?: string;
}

function day(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  // Deadlines are end-of-day instants: step back 1 ms so the civil day is the intended one.
  const civil = civilDate(new Date(Date.parse(iso) - 1), timeZone);
  return civil ? `${civilWeekday(civil)} ${civilDayMonth(civil)}` : "—";
}

/**
 * "Client can see this job" in ONE wording pair (plan §5): "Yes" · "Not yet" (portal client, not shared,
 * with [Share progress] for those who may, else a one-line helper) · "No (client has no portal)".
 */
function ClientCanSee({ side, jobId, version, clientName, canShare, timeZone }: Omit<SideColumnProps, "className">) {
  if (!side.clientHasPortal) return <span data-client-can-see="no-portal">No (client has no portal)</span>;
  if (side.clientCanSee) return <span data-client-can-see="yes">Yes</span>;
  return (
    <span className="flex flex-col items-end gap-1" data-client-can-see="not-yet">
      <span>Not yet</span>
      {canShare ? (
        <ShareProgressButton jobId={jobId} version={version} clientName={clientName} timeZone={timeZone} />
      ) : (
        <span className="text-xs text-ink-muted">They&apos;ll see it when the work is sent to them.</span>
      )}
    </span>
  );
}

/** Side column (plan §5): Shoot date · Due date · Client delivery date (portal only) · Type of shoot · Rush · Client can see this job. Below the content on phones. */
export function SideColumn({ side, timeZone, jobId, version, clientName, canShare, className }: SideColumnProps) {
  const rows: [string, React.ReactNode][] = [
    ["Shoot date", day(side.shootDate, timeZone)],
    ["Due date", day(side.dueDate, timeZone)],
    ...(side.clientHasPortal ? ([["Client delivery date", day(side.clientDeliveryDate, timeZone)]] as [string, React.ReactNode][]) : []),
    [
      "Type of shoot",
      <span key="type" className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: side.jobType.colour || undefined }} />
        {side.jobType.name}
      </span>,
    ],
    ["Rush", side.rush ? "Yes" : "No"],
    ["Client can see this job", <ClientCanSee key="see" side={side} timeZone={timeZone} jobId={jobId} version={version} clientName={clientName} canShare={canShare} />],
  ];
  return (
    <SectionCard title="Details" as="h2" className={className}>
      <dl className="divide-y divide-border/70 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="text-right text-ink numeric">{value}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}
