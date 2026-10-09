import * as React from "react";
import { Timer } from "lucide-react";
import { StatTile } from "@/components/common";
import { ElapsedClock, PersonChip, CategoryPill } from "@/components/jobs";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { STATUS_CATEGORIES, type StatusCategory } from "@/lib/constants";
import { formatDateTime, formatTime } from "@/lib/dates";
import type { UserRef, WorkSessionView } from "@/lib/types";
import { formatSeconds } from "./format";

const END_REASONS: Record<NonNullable<WorkSessionView["endReason"]>, string> = {
  paused: "Paused",
  stopped: "Stopped",
  auto_status_change: "Status changed",
  auto_reassigned: "Reassigned",
  auto_timeout: "Timed out",
  auto_deactivated: "User deactivated",
};

export interface TimeTabProps {
  sessions: WorkSessionView[];
  timeZone: string;
  timeTrackingEnabled: boolean;
  /** The viewer only sees their own sessions (timer.view_others denied). */
  ownOnly: boolean;
}

/** Tracked work sessions per person and stage, with totals (spec §15). */
export function TimeTab({ sessions, timeZone, timeTrackingEnabled, ownOnly }: TimeTabProps) {
  if (sessions.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Timer}
          title="No time tracked yet"
          description={
            timeTrackingEnabled
              ? "Start the timer from the job header while editing. Sessions pause automatically when the job is submitted or reassigned."
              : "Time tracking is turned off for this studio."
          }
        />
      </Card>
    );
  }

  const total = sessions.reduce((s, x) => s + x.durationSeconds, 0);
  const byUser = new Map<string, { user: UserRef; seconds: number; count: number }>();
  const byCategory = new Map<StatusCategory, number>();
  for (const s of sessions) {
    const u = byUser.get(s.user.id) ?? { user: s.user, seconds: 0, count: 0 };
    u.seconds += s.durationSeconds;
    u.count += 1;
    byUser.set(s.user.id, u);
    byCategory.set(s.statusCategory, (byCategory.get(s.statusCategory) ?? 0) + s.durationSeconds);
  }
  const people = [...byUser.values()].sort((a, b) => b.seconds - a.seconds);
  const categories = STATUS_CATEGORIES.filter((c) => byCategory.has(c));
  const running = sessions.filter((s) => s.isRunning);
  const ordered = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return (
    <div className="flex flex-col gap-5">
      {ownOnly ? <p className="text-xs text-ink-muted">Showing your own sessions only.</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Total tracked" value={formatSeconds(total)} sub={`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`} icon={Timer} tone="accent" />
        <StatTile label="People" value={String(people.length)} sub={people.map((p) => p.user.name.split(" ")[0]).join(", ")} />
        <StatTile label="Running now" value={String(running.length)} sub={running.length > 0 ? running.map((r) => r.user.name).join(", ") : "No timer running"} tone={running.length > 0 ? "success" : "default"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">By person</h3>
          <ul className="flex flex-col gap-3">
            {people.map((p) => (
              <li key={p.user.id} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <PersonChip user={p.user} size="xs" />
                  <span className="text-sm text-ink numeric">{formatSeconds(p.seconds)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${total > 0 ? Math.max(2, (p.seconds / total) * 100) : 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">By stage</h3>
          <ul className="flex flex-col gap-2.5">
            {categories.map((c) => (
              <li key={c} className="flex items-center justify-between gap-3">
                <CategoryPill category={c} size="sm" />
                <span className="text-sm text-ink numeric">{formatSeconds(byCategory.get(c) ?? 0)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card flush className="overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold text-ink">Sessions</h3>
        </div>
        {/* Phones: cards */}
        <ul className="divide-y divide-border md:hidden">
          {ordered.map((s) => (
            <li key={s.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <PersonChip user={s.user} size="xs" />
                <span className="text-sm font-medium text-ink numeric">{s.isRunning ? <ElapsedClock startedAt={s.startedAt} /> : formatSeconds(s.durationSeconds)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <span>{s.statusName}</span>
                <span aria-hidden="true">·</span>
                <span className="numeric">
                  {formatDateTime(s.startedAt, timeZone)} → {s.endedAt ? formatTime(s.endedAt, timeZone) : "running"}
                </span>
                {s.endReason ? <span>· {END_REASONS[s.endReason]}</span> : null}
              </div>
              {s.note ? <p className="text-xs text-ink-secondary">{s.note}</p> : null}
            </li>
          ))}
        </ul>
        {/* Desktop: table */}
        <div className="hidden md:block">
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Stage</TH>
                <TH>Started</TH>
                <TH>Ended</TH>
                <TH numeric>Duration</TH>
                <TH>How it ended</TH>
              </TR>
            </THead>
            <TBody>
              {ordered.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <PersonChip user={s.user} size="xs" />
                  </TD>
                  <TD>
                    <span className="flex flex-col">
                      <span>{s.statusName}</span>
                      {s.note ? <span className="max-w-56 truncate text-xs text-ink-muted" title={s.note}>{s.note}</span> : null}
                    </span>
                  </TD>
                  <TD muted>{formatDateTime(s.startedAt, timeZone)}</TD>
                  <TD muted>{s.endedAt ? formatDateTime(s.endedAt, timeZone) : <span className="font-medium text-success-fg">Running</span>}</TD>
                  <TD numeric primary>
                    {s.isRunning ? <ElapsedClock startedAt={s.startedAt} /> : formatSeconds(s.durationSeconds)}
                  </TD>
                  <TD muted>{s.endReason ? END_REASONS[s.endReason] : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
