import * as React from "react";
import { GitCommitVertical, TriangleAlert, UserRoundCog } from "lucide-react";
import { PersonChip, StatusPill, statusColour } from "@/components/jobs";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { StatusCategory } from "@/lib/constants";
import { formatDateShort, formatDateTime, formatTime } from "@/lib/dates";
import type { StageView, TimelineRow } from "@/lib/types";
import { cn, initials } from "@/lib/utils";
import { formatSeconds, STAGE_LABELS, STAGES, stageOf, type Stage } from "./format";

function laneOf(category: StatusCategory): Stage | null {
  if (category === "new") return "assignment";
  return stageOf(category);
}

export interface TimelineTabProps {
  stages: StageView[];
  /** Org-average bottleneck flags per stage (getJobTimeline); optional. */
  timeline: TimelineRow | null;
  timeZone: string;
  /** ISO "now" from the server (open stages run up to it). */
  now: string;
}

/**
 * One job as a Gantt: a lane per production stage (Assignment → Editing →
 * Review → Revision → Approval → Delivery), bars per stage occupancy with the
 * editor holding it, and markers where work was re-attributed to another editor.
 */
export function TimelineTab({ stages, timeline, timeZone, now }: TimelineTabProps) {
  const bars = stages.map((s) => ({ stage: s, lane: laneOf(s.toCategory) }));
  const start = stages.length > 0 ? Date.parse(stages[0].enteredAt) : NaN;
  const endIso = stages.reduce((max, s) => {
    const e = s.exitedAt ?? now;
    return e > max ? e : max;
  }, stages[0]?.enteredAt ?? now);
  const end = Date.parse(endIso);
  const span = Math.max(1, end - start);

  if (stages.length === 0 || !Number.isFinite(start)) {
    return (
      <Card>
        <EmptyState icon={GitCommitVertical} title="No stages recorded yet" description="As the job moves through the workflow, each stage appears here as a bar with its duration and the editor holding it." />
      </Card>
    );
  }

  const bottleneck = new Set((timeline?.segments ?? []).filter((s) => s.isBottleneck).map((s) => s.stageId));
  const pos = (iso: string) => ((Date.parse(iso) - start) / span) * 100;
  const reattributions = stages.filter((s) => s.kind === "reattribution");
  const totals = new Map<Stage, number>();
  for (const b of bars) if (b.lane) totals.set(b.lane, (totals.get(b.lane) ?? 0) + b.stage.durationSeconds);
  const cancelled = stages.find((s) => s.toCategory === "cancelled" && s.isCurrent);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => new Date(start + f * span).toISOString());

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Stage timeline</h3>
          <p className="text-xs text-ink-muted numeric">
            {formatDateTime(stages[0].enteredAt, timeZone)} → {stages.some((s) => s.isCurrent && s.toCategory !== "completed" && s.toCategory !== "cancelled") ? "now" : formatDateTime(endIso, timeZone)} · {formatSeconds((end - start) / 1000)}
          </p>
        </div>

        <div className="overflow-x-auto scrollbar-thin">
          <div className="min-w-[520px]">
            {/* axis */}
            <div className="ml-[104px] flex justify-between pb-1.5 text-2xs text-ink-subtle numeric" aria-hidden="true">
              {ticks.map((t, i) => (
                <span key={i}>{span < 2 * 86_400_000 ? formatTime(t, timeZone) : formatDateShort(t, timeZone)}</span>
              ))}
            </div>
            <div className="relative">
              {/* reattribution markers span all lanes */}
              {reattributions.map((r) => (
                <span
                  key={r.id}
                  className="pointer-events-none absolute inset-y-0 z-10 ml-[104px] w-px border-l border-dashed border-attention"
                  style={{ left: `calc((100% - 104px) * ${pos(r.enteredAt) / 100})` }}
                  aria-hidden="true"
                />
              ))}
              <ul className="flex flex-col gap-1.5" aria-label="Stages by lane">
                {STAGES.map((lane) => {
                  const inLane = bars.filter((b) => b.lane === lane);
                  return (
                    <li key={lane} className="flex items-center gap-2">
                      <div className="w-[96px] shrink-0">
                        <p className="truncate text-xs font-medium text-ink-secondary">{STAGE_LABELS[lane]}</p>
                        <p className="text-2xs text-ink-subtle numeric">{totals.get(lane) ? formatSeconds(totals.get(lane)) : "—"}</p>
                      </div>
                      <div className="relative h-8 flex-1 rounded-sm bg-surface-sunken ring-1 ring-inset ring-border/60">
                        {inLane.map(({ stage }) => {
                          const left = pos(stage.enteredAt);
                          const width = Math.max(0.8, pos(stage.exitedAt ?? now) - left);
                          const colour = statusColour({ category: stage.toCategory, colour: stage.toStatus.colour });
                          const slow = bottleneck.has(stage.id);
                          const editor = stage.editorAtEntry;
                          return (
                            <span
                              key={stage.id}
                              title={`${stage.statusName} · ${formatSeconds(stage.durationSeconds)}${editor ? ` · ${editor.name}` : ""}\n${formatDateTime(stage.enteredAt, timeZone)} → ${stage.exitedAt ? formatDateTime(stage.exitedAt, timeZone) : "now"}${slow ? "\nSlower than 2× the studio average" : ""}`}
                              className={cn(
                                "absolute inset-y-1 flex items-center overflow-hidden rounded-xs px-1 text-2xs font-medium text-white shadow-xs",
                                stage.isCurrent && "animate-pulse",
                                slow && "ring-2 ring-danger ring-offset-1 ring-offset-surface",
                              )}
                              style={{ left: `${left}%`, width: `${width}%`, backgroundColor: colour }}
                            >
                              {width > 7 && editor ? <span className="truncate">{initials(editor.name)}</span> : null}
                            </span>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3 w-px border-l border-dashed border-attention" /> Work re-attributed to another editor
          </span>
          {bottleneck.size > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-xs ring-2 ring-danger" /> More than 2× the studio average for that stage
            </span>
          ) : null}
          {cancelled ? <span className="text-ink-secondary">Cancelled {formatDateTime(cancelled.enteredAt, timeZone)}</span> : null}
        </div>
      </Card>

      <Card flush className="overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold text-ink">Every stage</h3>
          <p className="text-xs text-ink-muted">Each status the job entered, who held it and for how long.</p>
        </div>
        <ol className="divide-y divide-border">
          {stages.map((s) => (
            <li key={s.id} className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-5 py-3 sm:grid-cols-[auto_minmax(0,1fr)_160px_120px]", s.isCurrent && "bg-accent-soft/30")}>
              <span className="numeric w-6 text-right text-2xs text-ink-subtle">{s.sequence}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                {s.kind === "reattribution" ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-attention-fg">
                    <UserRoundCog aria-hidden="true" className="size-3.5" /> Re-attributed
                  </span>
                ) : null}
                <StatusPill status={s.toStatus} size="sm" />
                {s.isOverride ? <span className="text-2xs font-medium text-warning-fg">override</span> : null}
                {s.isReopen ? <span className="text-2xs font-medium text-info-fg">reopened</span> : null}
                {bottleneck.has(s.id) ? (
                  <span className="inline-flex items-center gap-1 text-2xs font-medium text-danger-fg">
                    <TriangleAlert aria-hidden="true" className="size-3" /> slow
                  </span>
                ) : null}
                <span className="text-xs text-ink-muted numeric">{formatDateTime(s.enteredAt, timeZone)}</span>
              </span>
              <span className="col-start-2 sm:col-start-auto">
                <PersonChip user={s.editorAtEntry} size="xs" emptyLabel="No editor" />
              </span>
              <span className="col-start-2 text-sm text-ink numeric sm:col-start-auto sm:text-right">
                {formatSeconds(s.durationSeconds)}
                {s.isCurrent ? <span className="ml-1 text-2xs text-accent-ink">ongoing</span> : null}
                {s.activeSeconds > 0 ? <span className="block text-2xs text-ink-muted">{formatSeconds(s.activeSeconds)} tracked</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
