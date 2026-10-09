import * as React from "react";
import {
  AlarmClock,
  ArchiveRestore,
  BadgeCheck,
  Ban,
  CalendarClock,
  Check,
  CircleCheckBig,
  CircleDot,
  Eye,
  History,
  PackageCheck,
  Play,
  Plus,
  RotateCcw,
  Send,
  Undo2,
  UserMinus,
  UserPlus,
  UserRoundCog,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { StatusPill, statusColour } from "@/components/jobs";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { STATUS_CATEGORY_META } from "@/lib/constants";
import { addCivilDays, civilDate, formatDate, formatDateTime, formatTime, formatWeekday, todayCivil } from "@/lib/dates";
import type { ActivityFeedItem, HistoryEntry, StageView, StatusRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatSeconds, valueChanges } from "./format";

/* ------------------------------------------------------------------ */
/*  Moments: stages enriched with the milestone events they caused     */
/* ------------------------------------------------------------------ */

interface Moment {
  key: string;
  at: string;
  icon: LucideIcon;
  /** Dot colour (status colour for stage moments). */
  colour: string | null;
  tone: "default" | "danger" | "attention" | "success";
  actor: string | null;
  sentence: React.ReactNode;
  status?: StatusRef;
  details: React.ReactNode[];
  badges: { label: string; tone: "success" | "danger" | "warning" | "info" | "neutral" }[];
}

function meta(e: ActivityFeedItem | undefined, key: string): unknown {
  return e?.metadata?.[key];
}

function nv(e: ActivityFeedItem | undefined, key: string): unknown {
  const v = e?.newValue;
  return v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
}

function actorOf(stage: StageView | null, events: ActivityFeedItem[]): string {
  if (stage?.actor) return stage.actor.name;
  const withActor = events.find((e) => e.actor);
  if (withActor?.actor) return withActor.actor.name;
  if (events.some((e) => e.metadata?.cause === "automation" || e.metadata?.automationRunId)) return "Automation";
  return "System";
}

function Name({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

function stageMoment(stage: StageView, linked: ActivityFeedItem[], assignment: ActivityFeedItem | undefined, previous: StageView | null): Moment {
  const A = actorOf(stage, linked);
  const find = (t: string) => linked.find((e) => e.eventType === t);
  const editor = stage.editorAtEntry?.name;
  const base: Moment = {
    key: stage.id,
    at: stage.enteredAt,
    icon: CircleDot,
    colour: statusColour({ category: stage.toCategory, colour: stage.toStatus.colour }),
    tone: "default",
    actor: A,
    sentence: null,
    status: stage.toStatus,
    details: [],
    badges: [],
  };
  if (stage.isOverride) base.badges.push({ label: "Override", tone: "warning" });
  if (stage.reason && stage.toCategory !== "revision") base.details.push(<>“{stage.reason}”</>);
  if (previous && previous.durationSeconds > 0 && stage.kind !== "reattribution") {
    base.details.push(
      <>
        after {formatSeconds(previous.durationSeconds)} in {previous.statusName}
      </>,
    );
  }

  if (stage.kind === "creation") {
    return { ...base, icon: Plus, sentence: <><Name>{A}</Name> created the job</> };
  }
  if (stage.kind === "reattribution") {
    return {
      ...base,
      icon: UserRoundCog,
      tone: "attention",
      sentence: (
        <>
          <Name>{A}</Name> re-attributed {stage.statusName.toLowerCase()} to <Name>{editor ?? "no editor"}</Name>
        </>
      ),
      details: stage.reason && stage.reason !== "reassigned" ? [<>“{stage.reason}”</>] : [],
    };
  }
  if (stage.kind === "migration") {
    return { ...base, icon: Workflow, sentence: <><Name>{A}</Name> moved the job to another workflow</> };
  }
  if (stage.fromCategory === "cancelled") {
    return { ...base, icon: ArchiveRestore, tone: "success", sentence: <><Name>{A}</Name> restored the job</> };
  }

  switch (stage.toCategory) {
    case "new":
      return { ...base, icon: Undo2, sentence: <><Name>{A}</Name> moved the job back to draft</> };
    case "ready": {
      if (find("job.declined")) return { ...base, icon: UserMinus, tone: "attention", sentence: <><Name>{A}</Name> declined the job</> };
      if (stage.fromCategory && STATUS_CATEGORY_META[stage.fromCategory].editorHolds) {
        return { ...base, icon: UserMinus, sentence: <><Name>{A}</Name> unassigned the editor</> };
      }
      return { ...base, icon: Check, sentence: <><Name>{A}</Name> marked the job ready for assignment</> };
    }
    case "assigned": {
      const who = editor ?? (assignment ? "the new editor" : "an editor");
      const verb = stage.fromCategory === "accepted" || stage.fromCategory === "assigned" ? "reassigned the job to" : "assigned the job to";
      return { ...base, icon: UserPlus, sentence: <><Name>{A}</Name> {verb} <Name>{who}</Name></> };
    }
    case "accepted":
      return { ...base, icon: Check, sentence: <><Name>{A}</Name> accepted the job</> };
    case "in_progress": {
      if (stage.isReopen) return { ...base, icon: RotateCcw, tone: "attention", sentence: <><Name>{A}</Name> reopened the job for more editing</> };
      if (find("job.work_started")) return { ...base, icon: Play, sentence: <><Name>{A}</Name> started editing</> };
      return { ...base, icon: Play, sentence: <><Name>{A}</Name> {stage.fromCategory === "assigned" ? "started editing" : "resumed editing"}</> };
    }
    case "submitted": {
      const warn = find("job.submitted");
      return { ...base, icon: Send, sentence: <><Name>{A}</Name> submitted the work for review</>, badges: warn && meta(warn, "resubmission") ? [...base.badges, { label: "Resubmission", tone: "info" }] : base.badges };
    }
    case "review":
      return { ...base, icon: Eye, sentence: <><Name>{A}</Name> started reviewing</> };
    case "revision": {
      const req = find("revision.requested");
      const n = (meta(req, "revisionNumber") ?? nv(req, "revisionNumber")) as number | undefined;
      const reason = (nv(req, "reason") as string | undefined) ?? stage.reason ?? undefined;
      return {
        ...base,
        icon: RotateCcw,
        tone: "danger",
        sentence: (
          <>
            <Name>{A}</Name> {stage.isReopen ? "reopened the job and requested" : "requested"} revision{n ? ` #${n}` : ""}
            {reason ? <span className="text-ink-secondary"> — {reason}</span> : null}
          </>
        ),
        details: [...(editor ? [<>assigned to {editor}</>] : []), ...base.details],
      };
    }
    case "resubmitted": {
      const res = find("revision.resolved");
      const n = (meta(res, "revisionNumber") ?? nv(res, "revisionNumber")) as number | undefined;
      return { ...base, icon: Send, sentence: <><Name>{A}</Name> resubmitted{n ? ` revision #${n}` : ""}</> };
    }
    case "approved": {
      const appr = find("job.approved");
      const onTime = meta(appr, "onTime");
      const badges = [...base.badges];
      if (onTime === true) badges.push({ label: "On time", tone: "success" });
      if (onTime === false) badges.push({ label: "Late", tone: "danger" });
      if (stage.isReopen) return { ...base, icon: RotateCcw, tone: "attention", badges, sentence: <><Name>{A}</Name> reopened the job to fix the delivery</> };
      return { ...base, icon: BadgeCheck, tone: "success", badges, sentence: <><Name>{A}</Name> approved the work</> };
    }
    case "delivered":
      return { ...base, icon: PackageCheck, tone: "success", sentence: <><Name>{A}</Name> delivered the work to the client</> };
    case "completed":
      return { ...base, icon: CircleCheckBig, tone: "success", sentence: <><Name>{A}</Name> completed the job</> };
    case "cancelled":
      return { ...base, icon: Ban, tone: "danger", sentence: <><Name>{A}</Name> cancelled the job</> };
    default:
      return { ...base, sentence: <><Name>{A}</Name> moved the job to {stage.statusName}</> };
  }
}

const EVENT_ICONS: Partial<Record<string, LucideIcon>> = {
  "assignment.created": UserPlus,
  "assignment.ended": UserMinus,
  "job.due_date_changed": CalendarClock,
  "job.became_overdue": AlarmClock,
  "job.workflow_migrated": Workflow,
  "job.stage_reattributed": UserRoundCog,
  "revision.requested": RotateCcw,
  "revision.resolved": Send,
  "job.approved": BadgeCheck,
  "job.completed": CircleCheckBig,
  "job.cancelled": Ban,
  "job.reopened": RotateCcw,
  "job.restored": ArchiveRestore,
  "job.created": Plus,
};

function eventMoment(e: ActivityFeedItem, timeZone: string): Moment {
  const A = actorOf(null, [e]);
  const changes = e.eventType.endsWith("date_changed") ? valueChanges(e.previousValue, e.newValue, (iso) => formatDate(iso, timeZone)) : [];
  return {
    key: e.id,
    at: e.createdAt,
    icon: EVENT_ICONS[e.eventType] ?? History,
    colour: null,
    tone: e.eventType === "job.became_overdue" ? "danger" : "default",
    actor: A,
    sentence:
      e.eventType === "job.became_overdue" ? (
        <>The job became <Name>overdue</Name></>
      ) : (
        <>
          <Name>{A}</Name> {e.summary}
        </>
      ),
    details: changes.map((c) => (
      <span key={c.key} className="numeric">
        {c.before ?? "none"} → {c.after ?? "none"}
      </span>
    )),
    badges: [],
  };
}

/** Merges stages with their milestone events into one moment per thing that happened. */
export function buildMoments(entries: HistoryEntry[], timeZone: string): Moment[] {
  const stages = entries.filter((e) => e.kind === "stage" && e.stage).map((e) => e.stage as StageView);
  const events = entries.filter((e) => e.kind === "event" && e.event).map((e) => e.event as ActivityFeedItem);
  const stageIds = new Set(stages.map((s) => s.id));
  const linked = new Map<string, ActivityFeedItem[]>();
  const consumed = new Set<string>();

  for (const e of events) {
    const t = e.metadata?.transitionId;
    if (typeof t === "string" && stageIds.has(t)) {
      linked.set(t, [...(linked.get(t) ?? []), e]);
      consumed.add(e.id);
    }
  }
  // An assignment that moved the job into "assigned" is the same moment as that stage.
  const assignmentFor = new Map<string, ActivityFeedItem>();
  for (const s of stages) {
    if (s.toCategory !== "assigned") continue;
    const a = events.find((e) => e.eventType === "assignment.created" && e.createdAt === s.enteredAt && !consumed.has(e.id));
    if (a) {
      assignmentFor.set(s.id, a);
      consumed.add(a.id);
      // The closing of the previous editor's assignment at the same instant is implied ("reassigned").
      const ended = events.find((e) => e.eventType === "assignment.ended" && e.createdAt === s.enteredAt && !consumed.has(e.id));
      if (ended && (s.fromCategory === "assigned" || s.fromCategory === "accepted")) consumed.add(ended.id);
    }
  }

  const moments: Moment[] = [];
  let previous: StageView | null = null;
  for (const entry of entries) {
    if (entry.kind === "stage" && entry.stage) {
      moments.push(stageMoment(entry.stage, linked.get(entry.stage.id) ?? [], assignmentFor.get(entry.stage.id), previous));
      previous = entry.stage;
    } else if (entry.kind === "event" && entry.event && !consumed.has(entry.event.id)) {
      if (entry.event.eventType === "job.status_changed") continue;
      moments.push(eventMoment(entry.event, timeZone));
    }
  }
  return moments;
}

/* ------------------------------------------------------------------ */
/*  Rendering                                                           */
/* ------------------------------------------------------------------ */

function dayLabel(civil: string, timeZone: string): string {
  const today = todayCivil(timeZone);
  if (civil === today) return "Today";
  if (civil === addCivilDays(today, -1)) return "Yesterday";
  const [y, m, d] = civil.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return `${formatWeekday(date, "UTC")} ${formatDate(civil, timeZone)}`;
}

const TONE_RING: Record<Moment["tone"], string> = {
  default: "bg-surface text-ink-secondary ring-border",
  danger: "bg-danger-soft text-danger ring-danger/25",
  attention: "bg-attention-soft text-attention ring-attention/25",
  success: "bg-success-soft text-success ring-success/25",
};

const BADGE_TONE: Record<Moment["badges"][number]["tone"], string> = {
  success: "bg-success-soft text-success-fg",
  danger: "bg-danger-soft text-danger-fg",
  warning: "bg-warning-soft text-warning-fg",
  info: "bg-info-soft text-info-fg",
  neutral: "bg-surface-muted text-ink-secondary",
};

export interface HistoryTabProps {
  entries: HistoryEntry[];
  timeZone: string;
  current: StatusRef;
}

/**
 * The job's permanent story (spec §18): a chronological vertical timeline with
 * day separators, one line per thing that happened. Read-only by design.
 */
export function HistoryTab({ entries, timeZone, current }: HistoryTabProps) {
  const moments = buildMoments(entries, timeZone);
  if (moments.length === 0) {
    return (
      <Card>
        <EmptyState icon={History} title="No history yet" description="Every status change, assignment and revision will be recorded here permanently." />
      </Card>
    );
  }

  const days: { civil: string; items: Moment[] }[] = [];
  for (const m of moments) {
    const civil = civilDate(m.at, timeZone) ?? m.at.slice(0, 10);
    const last = days[days.length - 1];
    if (last && last.civil === civil) last.items.push(m);
    else days.push({ civil, items: [m] });
  }

  return (
    <Card className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Job history</h3>
          <p className="text-xs text-ink-muted">{moments.length} recorded moments · oldest first · permanent and read-only</p>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-ink-muted">
          Now <StatusPill status={current} size="sm" />
        </span>
      </div>

      <ol aria-label="Job history" className="flex flex-col">
        {days.map((day) => (
          <li key={day.civil} className="flex flex-col">
            <div className="flex items-center gap-3 py-2">
              <span className="eyebrow whitespace-nowrap text-ink-secondary">{dayLabel(day.civil, timeZone)}</span>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </div>
            <ol className="flex flex-col">
              {day.items.map((m, i) => {
                const Icon = m.icon;
                const lastOfAll = day === days[days.length - 1] && i === day.items.length - 1;
                return (
                  <li key={m.key} className="group grid grid-cols-[3.75rem_2rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[4.5rem_2rem_minmax(0,1fr)]">
                    <time dateTime={m.at} title={formatDateTime(m.at, timeZone)} className="pt-1.5 text-right text-xs text-ink-muted numeric">
                      {formatTime(m.at, timeZone)}
                    </time>
                    <div className="relative flex justify-center">
                      {!lastOfAll ? <span aria-hidden="true" className="absolute inset-y-0 top-8 w-px bg-border" /> : null}
                      <span className={cn("relative z-[1] mt-0.5 flex size-7 items-center justify-center rounded-full ring-1 ring-inset", TONE_RING[m.tone])}>
                        <Icon aria-hidden="true" className="size-3.5" />
                        {m.colour ? <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface" style={{ backgroundColor: m.colour }} /> : null}
                      </span>
                    </div>
                    <div className="min-w-0 pb-5 pt-1">
                      <p className="text-sm leading-6 text-ink-secondary">
                        {m.sentence}
                        {m.badges.map((b) => (
                          <span key={b.label} className={cn("ml-2 inline-flex h-5 items-center rounded-full px-2 align-middle text-2xs font-medium", BADGE_TONE[b.tone])}>
                            {b.label}
                          </span>
                        ))}
                      </p>
                      {m.status || m.details.length > 0 ? (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                          {m.status ? <StatusPill status={m.status} size="xs" /> : null}
                          {m.details.map((d, k) => (
                            <span key={k} className="min-w-0 break-words">
                              {d}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </Card>
  );
}
