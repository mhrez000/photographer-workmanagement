"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Diamond } from "lucide-react";
import { jobHref } from "@/components/jobs/job-link";
import { PersonChip } from "@/components/jobs/person";
import { CATEGORY_GROUPS, type StatusCategory } from "@/lib/constants";
import { formatDateTime, formatDuration, formatDate } from "@/lib/dates";
import type { TimelineEvent, TimelineRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { categoryColour, groupRows, stageOf, type TimelineGroup, type TimelineWindow } from "./timeline-utils";

export interface TimelineGanttProps {
  rows: TimelineRow[];
  group: TimelineGroup;
  /** Civil days of the window (org timezone). */
  days: string[];
  /** Epoch ms of the start of each day, plus the end of the last day (days.length + 1 entries). */
  dayStarts: number[];
  nowMs: number;
  today: string;
  /** Org-wide usual (median, floored) closed-stage seconds per category (slow-stage baseline). */
  baselines: Partial<Record<StatusCategory, number>>;
  /** Slow-stage multiplier over the baseline (TIMELINE_BOTTLENECK_FACTOR). */
  slowFactor: number;
  timeZone: string;
  weeks: TimelineWindow;
}

const DAY_WIDTH: Record<TimelineWindow, number> = { 2: 56, 4: 32, 8: 18 };
const ROW_HEIGHT = 44;

interface HoverState {
  seg: TimelineEvent;
  rect: DOMRect;
}

/**
 * Gantt of job stages over a date window (spec §11). Sticky job labels on
 * the left, one bar per stage from the transition ledger (current stage runs
 * to "now"), a due-date marker per job, overdue rows tinted, and slow stages
 * (isSlowStage: over 2× the usual time, or a current stage past its deadline)
 * outlined in the attention colour.
 */
export function TimelineGantt({ rows, group, days, dayStarts, nowMs, today, baselines, slowFactor, timeZone, weeks }: TimelineGanttProps) {
  const dayWidth = DAY_WIDTH[weeks];
  const trackWidth = days.length * dayWidth;
  const rangeStart = dayStarts[0];
  const rangeEnd = dayStarts[dayStarts.length - 1];
  const scroller = React.useRef<HTMLDivElement>(null);
  const labelRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<HoverState | null>(null);

  /** Pixel x of an instant (DST-aware: each civil day is one column). */
  const xOf = React.useCallback(
    (ms: number): number => {
      if (ms <= rangeStart) return 0;
      if (ms >= rangeEnd) return trackWidth;
      let i = 0;
      while (i < days.length - 1 && dayStarts[i + 1] <= ms) i++;
      const span = dayStarts[i + 1] - dayStarts[i];
      return i * dayWidth + ((ms - dayStarts[i]) / span) * dayWidth;
    },
    [dayStarts, dayWidth, days.length, rangeEnd, rangeStart, trackWidth],
  );

  const nowVisible = nowMs >= rangeStart && nowMs <= rangeEnd;
  const nowX = xOf(nowMs);

  // Bring "now" into view on first paint / window change.
  React.useEffect(() => {
    const el = scroller.current;
    if (!el || !nowVisible) return;
    // The sticky label column covers the first labelW px of the viewport, so
    // the visible track is [scrollLeft, scrollLeft + clientWidth − labelW] in
    // track coordinates: put "now" 60 % of the way across it.
    const labelW = labelRef.current?.offsetWidth ?? 0;
    el.scrollLeft = Math.max(0, nowX - (el.clientWidth - labelW) * 0.6);
  }, [nowVisible, nowX, weeks, rangeStart]);

  const groups = React.useMemo(() => groupRows(rows, group), [rows, group]);

  const monthMarks = days.map((d, i) => ({ d, i, show: i === 0 || d.endsWith("-01") }));

  return (
    <div className="relative">
      <div ref={scroller} className="overflow-x-auto rounded-lg border border-border bg-surface shadow-xs scrollbar-thin" onScroll={() => setHover(null)}>
        <div className="relative [--gantt-label:9rem] sm:[--gantt-label:15rem]" style={{ minWidth: "100%", width: "max-content" }}>
          {/* Header */}
          <div className="sticky top-0 z-(--z-shell) flex border-b border-border bg-surface">
            <div ref={labelRef} className="sticky left-0 z-(--z-shell) flex w-36 shrink-0 items-end border-r border-border bg-surface px-3 pb-2 sm:w-60">
              <span className="eyebrow">Job</span>
            </div>
            <div className="relative" style={{ width: trackWidth }}>
              {/* Month labels sit in their own row (relative, so they never drop onto the day numbers); the Now pill lives here too. */}
              <div className="relative h-6">
                {monthMarks.map(({ d, i, show }) =>
                  show ? (
                    <span key={d} className="absolute bottom-0.5 whitespace-nowrap pl-1.5 text-2xs leading-4 font-semibold text-ink-secondary" style={{ left: i * dayWidth }}>
                      {formatMonth(d)}
                    </span>
                  ) : null,
                )}
                {nowVisible ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0.5 z-[1] -translate-x-1/2 rounded-full bg-accent px-1.5 py-0.5 text-[9px] leading-none font-semibold uppercase tracking-wide text-accent-fg"
                    style={{ left: nowX }}
                  >
                    Now
                  </span>
                ) : null}
              </div>
              <div className="flex">
                {days.map((d) => {
                  const date = new Date(`${d}T00:00:00Z`);
                  const dow = date.getUTCDay();
                  const weekend = dow === 0 || dow === 6;
                  const isToday = d === today;
                  return (
                    <div
                      key={d}
                      className={cn(
                        "flex h-7 shrink-0 flex-col items-center justify-center border-l border-border/60 text-2xs leading-none",
                        weekend && "bg-surface-sunken/70",
                        isToday ? "font-semibold text-accent-ink" : "text-ink-muted",
                      )}
                      style={{ width: dayWidth }}
                      title={formatDate(d)}
                    >
                      {weeks === 8 ? (
                        <span className="numeric">{dow === 1 || isToday ? date.getUTCDate() : ""}</span>
                      ) : (
                        <>
                          {weeks === 2 ? <span className="mb-0.5 text-[9px] uppercase tracking-wide opacity-70">{WEEKDAY[dow]}</span> : null}
                          <span className={cn("numeric", isToday && "rounded-full bg-accent px-1 py-px text-accent-fg")}>{date.getUTCDate()}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Body */}
          {groups.map((g) => {
            const bottlenecks = g.rows.reduce((n, r) => n + r.segments.filter((s) => s.isBottleneck).length, 0);
            return (
              <section key={g.key} aria-label={`${g.label}: ${g.rows.length} jobs`}>
                {group !== "job" ? (
                  <div className="flex border-b border-border bg-surface-muted/70">
                    <div className="sticky left-0 z-20 flex min-w-0 items-center gap-2 bg-surface-muted/95 px-3 py-1.5 backdrop-blur-sm" style={{ width: "max-content" }}>
                      {group === "editor" || group === "photographer" ? (
                        <PersonChip user={g.person} size="xs" emptyLabel={g.label} />
                      ) : (
                        <span className="truncate text-sm font-medium text-ink">
                          {g.label}
                          {g.sublabel ? <span className="font-normal text-ink-muted"> · {g.sublabel}</span> : null}
                        </span>
                      )}
                      <span className="numeric text-xs text-ink-muted">{g.rows.length}</span>
                      {bottlenecks > 0 ? (
                        <span className="numeric inline-flex items-center gap-1 rounded-full bg-attention-soft px-1.5 py-0.5 text-2xs font-medium text-attention-fg">
                          <AlertTriangle aria-hidden="true" className="size-3" />
                          {bottlenecks} slow {bottlenecks === 1 ? "stage" : "stages"}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {g.rows.map((row) => (
                  <GanttRow key={row.job.id} row={row} xOf={xOf} nowMs={nowMs} rangeStart={rangeStart} rangeEnd={rangeEnd} trackWidth={trackWidth} dayWidth={dayWidth} timeZone={timeZone} onHover={setHover} />
                ))}
              </section>
            );
          })}

          {/* Now line */}
          {nowVisible ? (
            <div aria-hidden="true" className="pointer-events-none absolute bottom-0 top-0 z-10" style={{ left: `calc(var(--gantt-label) + ${nowX}px)` }}>
              <div className="h-full w-px bg-accent" />
            </div>
          ) : null}
        </div>
      </div>

      {hover ? <SegmentTooltip hover={hover} baselines={baselines} slowFactor={slowFactor} timeZone={timeZone} /> : null}
    </div>
  );
}

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

function formatMonth(civil: string): string {
  return new Date(`${civil}T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
}

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

interface GanttRowProps {
  row: TimelineRow;
  xOf: (ms: number) => number;
  nowMs: number;
  rangeStart: number;
  rangeEnd: number;
  trackWidth: number;
  dayWidth: number;
  timeZone: string;
  onHover: (h: HoverState | null) => void;
}

function GanttRow({ row, xOf, nowMs, rangeStart, rangeEnd, trackWidth, dayWidth, timeZone, onHover }: GanttRowProps) {
  const { job } = row;
  const dueMs = job.dueDate ? Date.parse(job.dueDate) : null;
  const overdue = dueMs !== null && dueMs < nowMs && CATEGORY_GROUPS.DEADLINE_BOUND.includes(job.statusCategory);
  const dueVisible = dueMs !== null && dueMs >= rangeStart && dueMs <= rangeEnd;
  const href = jobHref(job.id);

  return (
    <div className={cn("group/row flex border-b border-border/70 last:border-b-0", overdue && "bg-danger-soft/35")} style={{ height: ROW_HEIGHT }}>
      <div
        className={cn(
          "sticky left-0 z-20 flex w-36 shrink-0 flex-col justify-center overflow-hidden border-r border-border px-3 sm:w-60",
          overdue ? "bg-[color-mix(in_oklab,var(--color-danger-soft)_35%,var(--color-surface))]" : "bg-surface",
          "group-hover/row:bg-surface-muted",
        )}
      >
        {/* Two fixed-height lines (number · client, then name) so the label always fits inside ROW_HEIGHT. */}
        <Link
          href={href}
          title={[job.jobNumber, job.name, job.client?.name].filter(Boolean).join(" · ")}
          className="flex min-w-0 flex-col gap-1 overflow-hidden rounded-xs leading-none focus-ring"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-2xs leading-none">
            <span className="numeric shrink-0 font-semibold text-ink-muted">{job.jobNumber}</span>
            {overdue ? <span className="shrink-0 rounded-full bg-danger-soft px-1 py-px text-[9px] leading-none font-semibold uppercase text-danger-fg">Overdue</span> : null}
            {job.client ? <span className="hidden min-w-0 truncate text-ink-subtle sm:inline">{job.client.name}</span> : null}
          </span>
          <span className="block truncate pb-px text-sm leading-tight font-medium text-ink hover:underline">{job.name}</span>
        </Link>
      </div>

      <div
        className="relative shrink-0"
        style={{
          width: trackWidth,
          backgroundImage: "linear-gradient(to right, color-mix(in oklab, var(--color-border) 55%, transparent) 1px, transparent 1px)",
          backgroundSize: `${dayWidth}px 100%`,
        }}
      >
        {row.segments.map((seg) => {
          const start = Date.parse(seg.startAt);
          const end = seg.endAt ? Date.parse(seg.endAt) : nowMs;
          if (end < rangeStart || start > rangeEnd) return null;
          const left = xOf(start);
          const width = Math.max(4, xOf(end) - left);
          const colour = categoryColour(seg.category);
          const stage = stageOf(seg.category);
          const label = `${stage.label} (${seg.statusName}) · ${formatDuration(seg.durationSeconds * 1000)}${seg.isCurrent ? " so far" : ""}${seg.isBottleneck ? " · slower than usual" : ""}`;
          return (
            <Link
              key={seg.stageId}
              href={href}
              aria-label={`${job.jobNumber}: ${label}`}
              onMouseEnter={(e) => onHover({ seg, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => onHover(null)}
              onFocus={(e) => onHover({ seg, rect: e.currentTarget.getBoundingClientRect() })}
              onBlur={() => onHover(null)}
              className={cn(
                "absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded-sm text-[10px] font-semibold text-white focus-ring",
                "transition-[filter,box-shadow] duration-(--motion-fast) hover:brightness-110",
                seg.isBottleneck && "ring-2 ring-attention ring-offset-1 ring-offset-surface",
                seg.isCurrent && "rounded-r-none",
              )}
              style={{
                left,
                width,
                backgroundColor: colour,
                backgroundImage: seg.isCurrent
                  ? `linear-gradient(to right, transparent 60%, color-mix(in oklab, ${colour} 40%, var(--color-surface)))`
                  : undefined,
              }}
            >
              {width > 64 ? <span className="truncate px-1.5 drop-shadow-sm">{stage.label}</span> : null}
              {seg.isBottleneck && width > 20 ? <AlertTriangle aria-hidden="true" className="ml-auto mr-1 size-3 shrink-0" /> : null}
            </Link>
          );
        })}

        {dueVisible && dueMs !== null ? (
          <span
            aria-label={`Due ${formatDateTime(job.dueDate, timeZone)}`}
            title={`Due ${formatDate(job.dueDate, timeZone)}`}
            className="absolute inset-y-1 z-[5] flex -translate-x-1/2 flex-col items-center"
            style={{ left: xOf(dueMs) }}
          >
            <span aria-hidden="true" className={cn("w-px flex-1", overdue ? "bg-danger" : "bg-ink-subtle/70")} />
            <Diamond aria-hidden="true" className={cn("size-2.5 shrink-0", overdue ? "fill-danger text-danger" : "fill-surface text-ink-muted")} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tooltip (fixed, so the scroll container never clips it)           */
/* ------------------------------------------------------------------ */

function SegmentTooltip({ hover, baselines, slowFactor, timeZone }: { hover: HoverState; baselines: Partial<Record<StatusCategory, number>>; slowFactor: number; timeZone: string }) {
  const { seg, rect } = hover;
  const stage = stageOf(seg.category);
  const usual = baselines[seg.category];
  // A current stage is also flagged when it has run past its deadline (see isSlowStage).
  const pastDeadline = seg.isBottleneck && seg.isCurrent && !(usual && seg.durationSeconds > slowFactor * usual);
  const took = formatDuration(seg.durationSeconds * 1000);
  const width = 260;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), (typeof window !== "undefined" ? window.innerWidth : 1024) - width - 8);
  const above = rect.top > 140;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-(--z-popover) rounded-md bg-ink px-3 py-2 text-xs leading-5 text-ink-inverse shadow-pop animate-fade-in"
      style={{ left, width, ...(above ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }) }}
    >
      <p className="font-semibold">
        {seg.jobNumber} · {stage.label}
        <span className="font-normal opacity-70"> — {seg.statusName}</span>
      </p>
      {seg.isBottleneck ? (
        <p className="font-medium text-attention">
          {stage.label} {seg.isCurrent ? "has taken" : "took"} {took}
          {pastDeadline ? " · past its due date" : usual ? ` (usually ${formatDuration(usual * 1000)})` : null}
        </p>
      ) : (
        <p>
          {seg.isCurrent ? "In this stage for " : "Took "}
          <span className="numeric font-medium">{took}</span>
          {usual ? <span className="opacity-70"> · usually {formatDuration(usual * 1000)}</span> : null}
        </p>
      )}
      <p className="numeric opacity-70">
        {formatDateTime(seg.startAt, timeZone)} → {seg.endAt ? formatDateTime(seg.endAt, timeZone) : "now"}
      </p>
      {seg.editor ? <p className="opacity-70">Editor: {seg.editor.name}</p> : null}
    </div>
  );
}
