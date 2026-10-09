import * as React from "react";
import Link from "next/link";
import { ArrowRight, Camera, CalendarClock } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { addCivilDays, civilDate, todayCivil } from "@/lib/dates";
import type { CalendarEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface CalendarDay {
  date: string;
  shoots: number;
  due: number;
  overdue: number;
}

/** Buckets shoot / due events into the next `days` civil days (org timezone). */
export function bucketCalendar(events: CalendarEvent[], timeZone: string, now: Date, days = 7): CalendarDay[] {
  const start = todayCivil(timeZone, now);
  const out: CalendarDay[] = Array.from({ length: days }, (_, i) => ({ date: addCivilDays(start, i), shoots: 0, due: 0, overdue: 0 }));
  const byDate = new Map(out.map((d) => [d.date, d]));
  for (const e of events) {
    const day = byDate.get(civilDate(e.at, timeZone) ?? "");
    if (!day) continue;
    if (e.kind === "shoot") day.shoots += 1;
    else if (e.kind === "due") {
      day.due += 1;
      if (e.isOverdue) day.overdue += 1;
    }
  }
  return out;
}

function dayLabel(civil: string, index: number): { top: string; bottom: string } {
  const [y, m, d] = civil.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone: "UTC" }).format(date);
  const dm = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
  return { top: index === 0 ? "Today" : index === 1 ? "Tomorrow" : weekday, bottom: dm };
}

function Count({ value, icon: Icon, label, tone }: { value: number; icon: typeof Camera; label: string; tone: string }) {
  return (
    <span
      className={cn("inline-flex min-w-11 items-center justify-end gap-1 numeric text-sm", value === 0 ? "text-ink-subtle" : tone)}
      title={`${value} ${label}`}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {value}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export interface CalendarMiniProps {
  days: CalendarDay[];
}

/** Next 7 days: shoots and editing deadlines per day; each day opens the calendar. */
export function CalendarMini({ days }: CalendarMiniProps) {
  const totalShoots = days.reduce((n, d) => n + d.shoots, 0);
  const totalDue = days.reduce((n, d) => n + d.due, 0);
  return (
    <SectionCard
      title="Next 7 days"
      description={`${totalShoots} ${totalShoots === 1 ? "shoot" : "shoots"} · ${totalDue} due`}
      flush
      footer={
        <Link href="/workspace/calendar" className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-ink hover:underline focus-ring">
          Open calendar
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      <ul className="divide-y divide-border">
        {days.map((day, i) => {
          const label = dayLabel(day.date, i);
          return (
            <li key={day.date}>
              <Link
                href={`/workspace/calendar?date=${day.date}`}
                className={cn(
                  "flex items-center gap-3 px-5 py-2 transition-colors duration-(--motion-fast) hover:bg-surface-muted/50 focus-ring-inset",
                  i === 0 && "bg-accent-soft/30",
                )}
              >
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className={cn("text-sm font-medium", i === 0 ? "text-accent-ink" : "text-ink")}>{label.top}</span>
                  <span className="numeric text-xs text-ink-muted">{label.bottom}</span>
                </span>
                <Count value={day.shoots} icon={Camera} label="shoots" tone="text-info-fg" />
                <Count
                  value={day.due}
                  icon={CalendarClock}
                  label="due"
                  tone={day.overdue > 0 ? "text-danger-fg" : i === 0 ? "text-attention-fg" : "text-ink-secondary"}
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
