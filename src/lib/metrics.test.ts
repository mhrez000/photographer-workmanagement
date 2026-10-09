import { describe, expect, it } from "vitest";
import type { StatusCategory } from "@/lib/constants";
import type { UserRef } from "@/lib/types";
import {
  approvingEditorId,
  avgSecondsPerCategory,
  completedInRange,
  daysRemaining,
  dueWeight,
  durationSeconds,
  editingSeconds,
  evaluateBottlenecks,
  firstEnter,
  historicalWorkloadSeries,
  isDueTodayAt,
  isDueWithinHours,
  isPastDue,
  kpiSummary,
  lastEnter,
  onTimeRate,
  photographerProcessingSeconds,
  reviewSeconds,
  revisionRate,
  timeInStage,
  turnaroundSeconds,
  workloadBand,
  workloadScore,
  type BottleneckEditor,
  type BottleneckInput,
  type BottleneckJob,
  type KpiJob,
  type TransitionLike,
  type WorkloadJob,
} from "./metrics";

const TZ = "Australia/Sydney"; // UTC+11 in October 2026
/** Friday 9 Oct 2026, 10:00 in Sydney. */
const NOW = "2026-10-08T23:00:00.000Z";
const H = 3_600_000;
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/* ------------------------------------------------------------------ */
/*  Durations and stage time                                           */
/* ------------------------------------------------------------------ */

describe("durationSeconds", () => {
  it("floors, uses now for open rows and never goes negative", () => {
    expect(durationSeconds("2026-10-08T00:00:00.000Z", "2026-10-08T00:00:01.999Z", NOW)).toBe(1);
    expect(durationSeconds("2026-10-08T22:00:00.000Z", null, NOW)).toBe(3600);
    expect(durationSeconds("2026-10-09T00:00:00.000Z", "2026-10-08T00:00:00.000Z", NOW)).toBe(0);
    expect(durationSeconds("garbage", null, NOW)).toBe(0);
  });
});

const t = (seq: number, kind: TransitionLike["kind"], toCategory: StatusCategory, enteredAt: string, exitedAt: string | null, editor: string | null, extra: Partial<TransitionLike> = {}): TransitionLike => ({
  sequence: seq,
  kind,
  toCategory,
  enteredAt,
  exitedAt,
  editorIdAtEntry: editor,
  ...extra,
});

/** Editor E1 starts, is replaced mid-stage by E2 (reattribution), submit, revision, resubmit (open). */
const HISTORY: TransitionLike[] = [
  t(1, "creation", "new", "2026-10-08T08:00:00.000Z", "2026-10-08T09:00:00.000Z", null),
  t(2, "transition", "assigned", "2026-10-08T09:00:00.000Z", "2026-10-08T10:00:00.000Z", "e1"),
  t(3, "transition", "in_progress", "2026-10-08T10:00:00.000Z", "2026-10-08T11:00:00.000Z", "e1", { durationSeconds: 3600 }),
  t(4, "reattribution", "in_progress", "2026-10-08T11:00:00.000Z", "2026-10-08T13:00:00.000Z", "e2"),
  t(5, "transition", "submitted", "2026-10-08T13:00:00.000Z", "2026-10-08T14:00:00.000Z", "e2"),
  t(6, "transition", "revision", "2026-10-08T14:00:00.000Z", "2026-10-08T14:30:00.000Z", "e2"),
  t(7, "transition", "resubmitted", "2026-10-08T14:30:00.000Z", null, "e2"),
];
const AT = "2026-10-08T15:00:00.000Z";

describe("stage metrics (incl. reattribution rows)", () => {
  it("timeInStage sums per category, the open row up to now", () => {
    expect(timeInStage(HISTORY, AT)).toEqual({ new: 3600, assigned: 3600, in_progress: 10800, submitted: 3600, revision: 1800, resubmitted: 1800 });
  });

  it("editingSeconds: total and per editor follow editor_id_at_entry", () => {
    expect(editingSeconds(HISTORY, AT)).toBe(3600 + 7200 + 1800);
    expect(editingSeconds(HISTORY, AT, "e1")).toBe(3600);
    expect(editingSeconds(HISTORY, AT, "e2")).toBe(7200 + 1800);
    expect(editingSeconds(HISTORY, AT, "nobody")).toBe(0);
  });

  it("reviewSeconds sums reviewer-held stages", () => {
    expect(reviewSeconds(HISTORY, AT)).toBe(3600 + 1800);
  });

  it("avgSecondsPerCategory uses closed rows of that editor", () => {
    expect(avgSecondsPerCategory(HISTORY, "e2")).toEqual({ in_progress: 7200, submitted: 3600, revision: 1800 });
    expect(avgSecondsPerCategory(HISTORY, "e1")).toEqual({ assigned: 3600, in_progress: 3600 });
  });

  it("firstEnter / lastEnter ignore reattribution rows", () => {
    expect(firstEnter(HISTORY, "in_progress")).toBe("2026-10-08T10:00:00.000Z");
    expect(lastEnter(HISTORY, "in_progress")).toBe("2026-10-08T10:00:00.000Z");
    expect(firstEnter(HISTORY, "approved")).toBeNull();
  });

  it("approvingEditorId = editor at entry of the latest approval", () => {
    expect(approvingEditorId(HISTORY)).toBeNull();
    const approved = [...HISTORY.slice(0, 6), { ...HISTORY[6], exitedAt: "2026-10-08T16:00:00.000Z" }, t(8, "transition", "approved", "2026-10-08T16:00:00.000Z", null, "e2")];
    expect(approvingEditorId(approved)).toBe("e2");
  });
});

describe("turnaroundSeconds", () => {
  const createdAt = "2026-10-08T08:00:00.000Z";
  const approvedAt = "2026-10-08T16:00:00.000Z";
  it("undefined until approved", () => {
    expect(turnaroundSeconds({ approvedAt: null, createdAt }, HISTORY)).toBeNull();
  });
  it("approved − first entry into assigned", () => {
    expect(turnaroundSeconds({ approvedAt, createdAt }, HISTORY)).toBe(7 * 3600);
  });
  it("falls back to in_progress, then createdAt", () => {
    const noAssigned = HISTORY.filter((x) => x.toCategory !== "assigned");
    expect(turnaroundSeconds({ approvedAt, createdAt }, noAssigned)).toBe(6 * 3600);
    expect(turnaroundSeconds({ approvedAt, createdAt }, [])).toBe(8 * 3600);
  });
  it("a reattribution into assigned does not reset the start", () => {
    const rows = [t(1, "reattribution", "assigned", "2026-10-08T12:00:00.000Z", null, "e2"), ...HISTORY];
    expect(turnaroundSeconds({ approvedAt, createdAt }, rows)).toBe(7 * 3600);
  });
});

describe("photographerProcessingSeconds", () => {
  // shoot_date is stored like a deadline: the last ms of the civil day (1 Oct, AEST +10).
  const SHOOT = "2026-10-01T13:59:59.999Z";
  it("first submission − start of the shoot day (org tz), and completion − creation", () => {
    expect(
      photographerProcessingSeconds(
        { shootDate: SHOOT, firstSubmittedAt: "2026-10-02T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-03T00:00:00.000Z" },
        "Australia/Sydney",
      ),
    ).toEqual({ processing: 34 * 3600, endToEnd: 2 * 86_400 }); // 1 Oct 00:00 AEST = 30 Sep 14:00Z
  });
  it("a submission on the shoot day is never negative", () => {
    const sameDay = photographerProcessingSeconds({ shootDate: SHOOT, firstSubmittedAt: "2026-10-01T05:00:00.000Z", createdAt: SHOOT, completedAt: null }, "Australia/Sydney");
    expect(sameDay.processing).toBe(15 * 3600);
    expect(sameDay.processing).toBeGreaterThanOrEqual(0);
    // clock skew / bad data: clamped at 0
    expect(photographerProcessingSeconds({ shootDate: SHOOT, firstSubmittedAt: "2026-09-29T00:00:00.000Z", createdAt: SHOOT, completedAt: null }, "Australia/Sydney").processing).toBe(0);
  });
  it("returns nulls when the dates are missing", () => {
    expect(photographerProcessingSeconds({ shootDate: null, firstSubmittedAt: null, createdAt: NOW, completedAt: null })).toEqual({ processing: null, endToEnd: null });
  });
});

/* ------------------------------------------------------------------ */
/*  Rates                                                              */
/* ------------------------------------------------------------------ */

describe("revisionRate", () => {
  const jobs = [
    { approvedAt: "2026-10-05T00:00:00.000Z", revisionCount: 0 },
    { approvedAt: "2026-10-06T00:00:00.000Z", revisionCount: 1 },
    { approvedAt: "2026-10-07T00:00:00.000Z", revisionCount: 2 },
    { approvedAt: "2026-09-01T00:00:00.000Z", revisionCount: 0 },
    { approvedAt: null, revisionCount: 3 },
  ];
  it("jobsWithRevision / jobsApproved and revisions per job", () => {
    expect(revisionRate(jobs)).toEqual({ rate: 0.5, revisionsPerJob: 0.75, jobsApproved: 4, jobsWithRevision: 2 });
  });
  it("respects the range (inclusive from, exclusive to)", () => {
    expect(revisionRate(jobs, { from: "2026-10-05T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z" })).toEqual({ rate: 0.5, revisionsPerJob: 0.5, jobsApproved: 2, jobsWithRevision: 1 });
  });
  it("null when nothing approved", () => {
    expect(revisionRate([{ approvedAt: null, revisionCount: 1 }])).toEqual({ rate: null, revisionsPerJob: null, jobsApproved: 0, jobsWithRevision: 0 });
  });
});

describe("onTimeRate", () => {
  it("judges against dueDateAtApproval, never the current due date", () => {
    const jobs = [
      // due date moved EARLIER after approval — still on time
      { approvedAt: "2026-10-05T00:00:00.000Z", dueDateAtApproval: "2026-10-06T00:00:00.000Z", dueDate: "2026-10-04T00:00:00.000Z" },
      // late
      { approvedAt: "2026-10-07T00:00:00.000Z", dueDateAtApproval: "2026-10-06T00:00:00.000Z", dueDate: "2026-10-30T00:00:00.000Z" },
      // stored flag wins
      { approvedAt: "2026-10-07T00:00:00.000Z", dueDateAtApproval: "2026-10-08T00:00:00.000Z", wasOnTime: true },
      // excluded: no due date at approval / not approved
      { approvedAt: "2026-10-07T00:00:00.000Z", dueDateAtApproval: null, dueDate: "2026-10-01T00:00:00.000Z" },
      { approvedAt: null, dueDateAtApproval: null },
    ];
    expect(onTimeRate(jobs)).toEqual({ rate: 2 / 3, onTime: 2, measured: 3 });
    expect(onTimeRate([])).toEqual({ rate: null, onTime: 0, measured: 0 });
  });
  it("approval exactly at the deadline is on time", () => {
    expect(onTimeRate([{ approvedAt: "2026-10-06T00:00:00.000Z", dueDateAtApproval: "2026-10-06T00:00:00.000Z" }]).rate).toBe(1);
  });
});

describe("completedInRange", () => {
  const thisWeek = { from: "2026-10-04T13:00:00.000Z", to: "2026-10-11T13:00:00.000Z" };
  const lastWeek = { from: "2026-09-27T14:00:00.000Z", to: "2026-10-04T13:00:00.000Z" };
  const jobs = [
    // completed last week, reopened, re-completed this week → this week only
    { id: "reopened", statusCategory: "completed" as const, completedAt: "2026-10-06T00:00:00.000Z" },
    { id: "lastweek", statusCategory: "completed" as const, completedAt: "2026-10-01T00:00:00.000Z" },
    // reopened and not yet re-completed → counts nowhere
    { id: "open-again", statusCategory: "revision" as const, completedAt: null },
    // stale completedAt on a non-completed job is ignored
    { id: "stale", statusCategory: "approved" as const, completedAt: "2026-10-06T00:00:00.000Z" },
    { id: "boundary", statusCategory: "completed" as const, completedAt: thisWeek.to },
  ];
  it("counts the latest completion once", () => {
    expect(completedInRange(jobs, thisWeek.from, thisWeek.to).map((j) => j.id)).toEqual(["reopened"]);
    expect(completedInRange(jobs, lastWeek.from, lastWeek.to).map((j) => j.id)).toEqual(["lastweek"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Deadlines + KPIs                                                   */
/* ------------------------------------------------------------------ */

describe("deadline helpers", () => {
  const endOf8 = "2026-10-08T12:59:59.999Z"; // end of 8 Oct (Sydney)
  const endOf9 = "2026-10-09T12:59:59.999Z"; // end of 9 Oct = today
  const endOf10 = "2026-10-10T12:59:59.999Z";
  it("overdue / due today / due within", () => {
    expect(isPastDue(endOf8, NOW)).toBe(true);
    expect(isPastDue(endOf9, NOW)).toBe(false);
    expect(isPastDue(null, NOW)).toBe(false);
    expect(isDueTodayAt(endOf9, NOW, TZ)).toBe(true);
    expect(isDueTodayAt(endOf10, NOW, TZ)).toBe(false);
    expect(isDueTodayAt(endOf8, NOW, TZ)).toBe(false);
    expect(isDueWithinHours(plus(NOW, 48 * H), NOW, 48)).toBe(true);
    expect(isDueWithinHours(plus(NOW, 48 * H + 1), NOW, 48)).toBe(false);
  });
  it("re-exports daysRemaining from dates", () => {
    expect(daysRemaining("2026-10-12T00:00:00.000Z", TZ, new Date(NOW))).toBe(3);
    expect(daysRemaining(null, TZ, new Date(NOW))).toBeNull();
  });
});

describe("kpiSummary", () => {
  const k = (statusCategory: StatusCategory, over: Partial<KpiJob> = {}): KpiJob => ({ statusCategory, dueDate: null, completedAt: null, ...over });
  const jobs: KpiJob[] = [
    k("in_progress", { dueDate: "2026-10-08T12:59:59.999Z" }), // overdue
    k("in_progress", { dueDate: "2026-10-09T12:59:59.999Z" }), // due today
    k("submitted", { dueDate: "2026-10-07T12:59:59.999Z", reviewDueDate: "2026-10-08T00:00:00.000Z" }), // overdue + review overdue
    k("approved", { dueDate: "2026-10-01T12:59:59.999Z" }), // done: never overdue
    k("new"),
    k("accepted", { isPaused: true }),
    k("revision", { dueDate: "2026-10-10T12:59:59.999Z" }),
    k("completed", { completedAt: "2026-10-06T00:00:00.000Z" }),
    k("completed", { completedAt: "2026-10-01T00:00:00.000Z" }),
    k("cancelled", { dueDate: "2026-10-01T12:59:59.999Z" }),
  ];
  it("counts every card per §8", () => {
    expect(kpiSummary(jobs, { now: NOW, tz: TZ })).toEqual({
      active: 7,
      dueToday: 1,
      overdue: 2,
      awaitingEditor: 1,
      inEditing: 2,
      awaitingReview: 1,
      revisionRequired: 1,
      completedThisWeek: 1,
      unassigned: 1,
      paused: 1,
      reviewOverdue: 1,
      asOf: NOW,
      // Mon 5 Oct – Mon 12 Oct (AEDT), exposed for the KPI drill-down link
      completedWeek: { from: "2026-10-04T13:00:00.000Z", to: "2026-10-11T13:00:00.000Z" },
    });
  });
  it("accepts an explicit week range (and reports it for the drill-down)", () => {
    const week = { from: "2026-09-27T14:00:00.000Z", to: "2026-10-04T13:00:00.000Z" };
    const k = kpiSummary(jobs, { now: NOW, tz: TZ, weekRange: week });
    expect(k.completedThisWeek).toBe(1);
    expect(k.completedWeek).toEqual(week);
  });
});

/* ------------------------------------------------------------------ */
/*  Workload                                                           */
/* ------------------------------------------------------------------ */

describe("workloadScore", () => {
  const w = (over: Partial<WorkloadJob>): WorkloadJob => ({ statusCategory: "in_progress", priority: "normal", dueDate: null, estimatedHours: null, jobTypeId: "jt-re", ...over });
  const opts = { settings: { defaultEstimatedHours: 2 }, jobTypeDefaults: { "jt-wedding": 12, "jt-re": null }, now: NOW, tz: TZ };

  it("applies hours × priority × due × category weights", () => {
    const jobs = [
      w({}), // 2 (org default hours)
      w({ priority: "urgent", estimatedHours: 4, dueDate: plus(NOW, -1) }), // 4 × 1.6 × 1.5 = 9.6
      w({ priority: "high", dueDate: plus(NOW, 48 * H) }), // 2 × 1.3 × 1.25 = 3.25 (48h boundary inclusive)
      w({ jobTypeId: "jt-wedding", dueDate: plus(NOW, 48 * H + 1) }), // 12 (job-type default, no due weight)
      w({ statusCategory: "submitted", estimatedHours: 4 }), // 4 × 0.25 = 1 (reviewer-held)
      w({ statusCategory: "new", estimatedHours: 50 }), // 0: not in WORKLOAD
      w({ statusCategory: "completed", estimatedHours: 50 }), // 0
      w({ priority: "low", estimatedHours: 5 }), // 5 × 0.8 = 4
    ];
    expect(workloadScore(jobs, opts)).toBeCloseTo(2 + 9.6 + 3.25 + 12 + 1 + 4, 10);
  });

  it("falls back to the global default when settings omit it", () => {
    expect(workloadScore([w({})], { settings: {}, jobTypeDefaults: {}, now: NOW })).toBe(2);
  });

  it("dueWeight", () => {
    expect(dueWeight(null, NOW)).toBe(1);
    expect(dueWeight(plus(NOW, -1), NOW)).toBe(1.5);
    expect(dueWeight(NOW, NOW)).toBe(1.25);
    expect(dueWeight(plus(NOW, 49 * H), NOW)).toBe(1);
  });
});

describe("workloadBand", () => {
  const base = { capacityHours: 10, settings: {}, activeCount: 1, overdueCount: 0, isActive: true };
  it.each([
    [6.99, "healthy"],
    [7, "near_capacity"],
    [9.99, "near_capacity"],
    [10, "overloaded"],
    [25, "overloaded"],
  ] as const)("score %s on 10h capacity → %s", (score, band) => {
    expect(workloadBand(score, base)).toMatchObject({ band, reason: "ratio", ratio: score / 10 });
  });

  it("org thresholds and default capacity", () => {
    expect(workloadBand(10, { ...base, capacityHours: null, settings: { defaultCapacityHoursPerWeek: 20 } })).toMatchObject({ band: "healthy", ratio: 0.5 });
    expect(workloadBand(10, { ...base, capacityHours: null, settings: { defaultCapacityHoursPerWeek: 20, workloadNearCapacityRatio: 0.5 } }).band).toBe("near_capacity");
    expect(workloadBand(19, { ...base, capacityHours: null })).toMatchObject({ band: "healthy", ratio: 0.5 }); // 38h default
  });

  it("hard caps", () => {
    expect(workloadBand(0, { ...base, activeCount: 12 })).toMatchObject({ band: "overloaded", reason: "max_active" });
    expect(workloadBand(0, { ...base, activeCount: 11 })).toMatchObject({ band: "healthy", reason: "ratio" });
    expect(workloadBand(0, { ...base, activeCount: 5, settings: { maxActiveJobsPerEditor: 5 } }).reason).toBe("max_active");
    expect(workloadBand(0, { ...base, overdueCount: 3 })).toMatchObject({ band: "overloaded", reason: "overdue_cap" });
    expect(workloadBand(0, { ...base, overdueCount: 2 }).band).toBe("healthy");
    expect(workloadBand(0, { ...base, isActive: false })).toMatchObject({ band: "overloaded", reason: "inactive" });
  });

  it("zero capacity", () => {
    expect(workloadBand(0, { ...base, capacityHours: 0 })).toMatchObject({ band: "healthy", ratio: 0 });
    expect(workloadBand(1, { ...base, capacityHours: 0 })).toMatchObject({ band: "overloaded", ratio: 999 });
  });
});

describe("historicalWorkloadSeries", () => {
  const assignments = [
    { jobId: "job-a", userId: "e1", role: "editor" as const, assignedAt: "2026-10-04T22:00:00.000Z", unassignedAt: "2026-10-06T22:00:00.000Z" },
    { jobId: "job-b", userId: "e1", role: "editor" as const, assignedAt: "2026-10-06T22:00:00.000Z", unassignedAt: null },
    { jobId: "job-c", userId: "e2", role: "editor" as const, assignedAt: "2026-10-01T00:00:00.000Z", unassignedAt: null },
    { jobId: "job-d", userId: "e1", role: "photographer" as const, assignedAt: "2026-10-01T00:00:00.000Z", unassignedAt: null },
  ];
  const transitions = [
    { jobId: "job-a", toCategory: "assigned" as const, enteredAt: "2026-10-04T22:00:00.000Z", exitedAt: "2026-10-05T22:00:00.000Z" },
    { jobId: "job-a", toCategory: "in_progress" as const, enteredAt: "2026-10-05T22:00:00.000Z", exitedAt: null },
    { jobId: "job-b", toCategory: "submitted" as const, enteredAt: "2026-10-05T00:00:00.000Z", exitedAt: "2026-10-07T20:00:00.000Z" },
    { jobId: "job-b", toCategory: "revision" as const, enteredAt: "2026-10-07T20:00:00.000Z", exitedAt: null },
    { jobId: "job-c", toCategory: "in_progress" as const, enteredAt: "2026-10-01T00:00:00.000Z", exitedAt: null },
    { jobId: "job-d", toCategory: "in_progress" as const, enteredAt: "2026-10-01T00:00:00.000Z", exitedAt: null },
  ];
  it("counts jobs whose editor assignment and editor-held stage are open at each day end", () => {
    const series = historicalWorkloadSeries(assignments, transitions, { from: "2026-10-05", to: "2026-10-08", timeZone: TZ, now: NOW }, { editorId: "e1", jobHours: { "job-a": 3 } });
    expect(series).toEqual([
      { date: "2026-10-05", count: 1, score: 3 }, // job-a assigned
      { date: "2026-10-06", count: 1, score: 3 }, // job-a in progress
      { date: "2026-10-07", count: 0, score: 0 }, // job-a unassigned; job-b reviewer-held
      { date: "2026-10-08", count: 1, score: 2 }, // job-b revision (default hours)
    ]);
  });
  it("clips today to now", () => {
    const series = historicalWorkloadSeries(assignments, transitions, { from: "2026-10-09", to: "2026-10-09", timeZone: TZ, now: "2026-10-07T19:00:00.000Z" }, { editorId: "e1" });
    expect(series).toEqual([{ date: "2026-10-09", count: 0, score: 0 }]); // at 19:00Z job-b is still submitted (reviewer-held)
  });
});

/* ------------------------------------------------------------------ */
/*  Bottlenecks                                                        */
/* ------------------------------------------------------------------ */

let seq = 0;
const bj = (over: Partial<BottleneckJob>): BottleneckJob => {
  seq += 1;
  return {
    id: `j${seq}`,
    jobNumber: `PJ-${String(seq).padStart(4, "0")}`,
    name: `Job ${seq}`,
    statusCategory: "in_progress",
    statusEnteredAt: NOW,
    dueDate: null,
    reviewDueDate: null,
    isPaused: false,
    lastActivityAt: NOW,
    editorId: "e1",
    ...over,
  };
};
const user = (id: string, isActive = true): UserRef => ({ id, name: `Editor ${id}`, role: "editor", avatarColour: "#000", isActive });
const input = (over: Partial<BottleneckInput>): BottleneckInput => ({ now: NOW, jobs: [], editors: [], revisions: { thisWeek: 0, previousWeeks: [] }, ...over });
const kinds = (i: BottleneckInput) => evaluateBottlenecks(i).map((a) => a.kind);

describe("evaluateBottlenecks", () => {
  it("quiet input → no alerts", () => {
    expect(evaluateBottlenecks(input({ jobs: [bj({})] }))).toEqual([]);
  });

  it("review: > 24h waiting, at least 3 jobs", () => {
    const old = plus(NOW, -24 * H - 1);
    const exactly = plus(NOW, -24 * H);
    expect(kinds(input({ jobs: [bj({ statusCategory: "submitted", statusEnteredAt: old }), bj({ statusCategory: "review", statusEnteredAt: old })] }))).toEqual([]);
    expect(kinds(input({ jobs: [bj({ statusCategory: "submitted", statusEnteredAt: old }), bj({ statusCategory: "review", statusEnteredAt: old }), bj({ statusCategory: "resubmitted", statusEnteredAt: exactly })] }))).toEqual([]);
    const alerts = evaluateBottlenecks(
      input({ jobs: [bj({ statusCategory: "submitted", statusEnteredAt: old }), bj({ statusCategory: "review", statusEnteredAt: old }), bj({ statusCategory: "resubmitted", statusEnteredAt: old })] }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "review", count: 3, severity: "warning", message: "Review bottleneck — 3 jobs waiting for review > 24h", detectedAt: NOW });
    expect(alerts[0].jobs).toHaveLength(3);
  });

  it("editor_overloaded: band overloaded, or max active with enough due soon", () => {
    const ed = (over: Partial<BottleneckEditor>): BottleneckEditor => ({ user: user("e1"), band: "healthy", active: 1, dueSoon: 0, ...over });
    expect(kinds(input({ editors: [ed({ band: "overloaded" })] }))).toEqual(["editor_overloaded"]);
    expect(kinds(input({ editors: [ed({ active: 12, dueSoon: 3 })] }))).toEqual(["editor_overloaded"]);
    expect(kinds(input({ editors: [ed({ active: 12, dueSoon: 2 })] }))).toEqual([]);
    expect(kinds(input({ editors: [ed({ active: 11, dueSoon: 5 })] }))).toEqual([]);
    expect(kinds(input({ editors: [ed({ band: "overloaded", user: user("e1", false) })] }))).toEqual([]);
    const [a] = evaluateBottlenecks(input({ editors: [ed({ band: "overloaded", active: 14, dueSoon: 5 })], jobs: [bj({ editorId: "e1" }), bj({ editorId: "e2" })] }));
    expect(a).toMatchObject({ severity: "critical", message: "Editing bottleneck — Editor e1 has 14 active jobs, 5 due within 48h" });
    expect(a.href).toBe("/workspace/all?editorId=e1&statusCategory=assigned,accepted,in_progress,submitted,review,revision,resubmitted");
    expect(a.user?.id).toBe("e1");
    expect(a.jobs).toHaveLength(1);
  });

  it("revision_spike: min count and multiplier over the 4-week baseline", () => {
    expect(kinds(input({ revisions: { thisWeek: 5, previousWeeks: [] } }))).toEqual(["revision_spike"]);
    expect(kinds(input({ revisions: { thisWeek: 4, previousWeeks: [] } }))).toEqual([]);
    expect(kinds(input({ revisions: { thisWeek: 6, previousWeeks: [4, 4, 4, 4] } }))).toEqual(["revision_spike"]);
    expect(kinds(input({ revisions: { thisWeek: 5, previousWeeks: [4, 4, 4, 4] } }))).toEqual([]);
    expect(kinds(input({ revisions: { thisWeek: 5, previousWeeks: [0, 0, 0, 0] } }))).toEqual(["revision_spike"]);
    // only the most recent 4 weeks form the baseline
    expect(kinds(input({ revisions: { thisWeek: 6, previousWeeks: [4, 4, 4, 4, 100] } }))).toEqual(["revision_spike"]);
    expect(evaluateBottlenecks(input({ revisions: { thisWeek: 14, previousWeeks: [5, 5, 5, 5] } }))[0].message).toBe("Revision bottleneck — 14 revision requests in the last 7 days");
  });

  it("revision_spike: counts requests for the rule, but reports and lists distinct jobs", () => {
    const j1 = { id: "a", jobNumber: "PJ-0001", name: "A" };
    const j2 = { id: "b", jobNumber: "PJ-0002", name: "B" };
    // 3 requests on 2 jobs (min count lowered to 3)
    const [a] = evaluateBottlenecks(input({ settings: { revisionSpikeMinCount: 3 }, revisions: { thisWeek: 3, previousWeeks: [], jobs: [j1, j2] } }));
    expect(a.kind).toBe("revision_spike");
    expect(a.message).toContain("3 revision requests on 2 jobs");
    expect(a.message).toBe("Revision bottleneck — 3 revision requests on 2 jobs in the last 7 days");
    expect(a.count).toBe(2);
    expect(a.count).toBe(a.jobs.length);
    expect(a.href).toBe(`/workspace/all?revisedFrom=${encodeURIComponent(plus(NOW, -7 * 24 * H))}&includeCancelled=1`);
  });

  it("editor_overloaded lists only WORKLOAD-held jobs, so jobs.length === count", () => {
    const held = [bj({ statusCategory: "in_progress" }), bj({ statusCategory: "submitted" }), bj({ statusCategory: "revision" })];
    const done = [bj({ statusCategory: "approved" }), bj({ statusCategory: "delivered" })];
    const [a] = evaluateBottlenecks(
      input({ editors: [{ user: user("e1"), band: "overloaded", active: held.length, dueSoon: 0 }], jobs: [...held, ...done] }),
    );
    expect(a.kind).toBe("editor_overloaded");
    expect(a.count).toBe(3);
    expect(a.jobs.map((j) => j.id)).toEqual(held.map((j) => j.id));
  });

  it("review links to the exact waiting set (statusEnteredBefore = now − h)", () => {
    const old = plus(NOW, -25 * H);
    const [a] = evaluateBottlenecks(input({ jobs: [1, 2, 3].map(() => bj({ statusCategory: "submitted", statusEnteredAt: old })) }));
    expect(a.href).toBe(`/workspace/all?quick=awaiting_review&statusEnteredBefore=${encodeURIComponent(plus(NOW, -24 * H))}`);
  });

  it("unassigned_backlog: ≥ 10 unassigned, or any due within 48h", () => {
    const nine = Array.from({ length: 9 }, () => bj({ statusCategory: "ready", editorId: null }));
    expect(kinds(input({ jobs: nine }))).toEqual([]);
    expect(kinds(input({ jobs: [...nine, bj({ statusCategory: "new", editorId: null })] }))).toEqual(["unassigned_backlog"]);
    const [a] = evaluateBottlenecks(input({ jobs: [bj({ statusCategory: "new", editorId: null, dueDate: plus(NOW, 48 * H) })] }));
    expect(a).toMatchObject({ kind: "unassigned_backlog", count: 1, message: "Unassigned backlog — 1 job waiting for an editor (1 due within 48h)" });
    expect(kinds(input({ jobs: [bj({ statusCategory: "new", editorId: null, dueDate: plus(NOW, 48 * H + 1) })] }))).toEqual([]);
  });

  it("stalled: active, not paused, no activity for more than N days", () => {
    const exactly = plus(NOW, -5 * 24 * H);
    const older = plus(exactly, -1);
    expect(kinds(input({ jobs: [bj({ lastActivityAt: exactly })] }))).toEqual([]);
    expect(kinds(input({ jobs: [bj({ lastActivityAt: older })] }))).toEqual(["stalled"]);
    expect(kinds(input({ jobs: [bj({ lastActivityAt: older, isPaused: true })] }))).toEqual([]);
    expect(kinds(input({ jobs: [bj({ lastActivityAt: older, statusCategory: "completed" })] }))).toEqual([]);
    expect(kinds(input({ jobs: [bj({ lastActivityAt: plus(NOW, -2 * 24 * H - 1) })], settings: { stalledDays: 2 } }))).toEqual(["stalled"]);
  });

  it("editor_unavailable: active jobs held by a deactivated editor", () => {
    expect(kinds(input({ jobs: [bj({ editorId: "gone" })], inactiveUserIds: ["gone"] }))).toEqual(["editor_unavailable"]);
    expect(kinds(input({ jobs: [bj({ editorId: "e9" })], editors: [{ user: user("e9", false), band: "overloaded", active: 1, dueSoon: 0 }] }))).toEqual(["editor_unavailable"]);
    expect(kinds(input({ jobs: [bj({ editorId: "gone", statusCategory: "cancelled" })], inactiveUserIds: ["gone"] }))).toEqual([]);
    expect(evaluateBottlenecks(input({ jobs: [bj({ editorId: "gone" }), bj({ editorId: "gone" })], inactiveUserIds: ["gone"] }))[0]).toMatchObject({
      severity: "critical",
      message: "2 jobs assigned to a deactivated editor",
    });
  });

  it("review_overdue: reviewer-held with review deadline passed", () => {
    expect(kinds(input({ jobs: [bj({ statusCategory: "review", reviewDueDate: plus(NOW, -1) })] }))).toEqual(["review_overdue"]);
    expect(kinds(input({ jobs: [bj({ statusCategory: "review", reviewDueDate: NOW })] }))).toEqual([]);
    expect(kinds(input({ jobs: [bj({ statusCategory: "in_progress", reviewDueDate: plus(NOW, -1) })] }))).toEqual([]);
  });

  it("returns alerts in BOTTLENECK_KINDS order", () => {
    const old = plus(NOW, -30 * H);
    const all = input({
      jobs: [
        ...Array.from({ length: 3 }, () => bj({ statusCategory: "review", statusEnteredAt: old, reviewDueDate: plus(NOW, -1) })),
        bj({ statusCategory: "new", editorId: null, dueDate: NOW }),
        bj({ lastActivityAt: plus(NOW, -10 * 24 * H) }),
        bj({ editorId: "gone" }),
      ],
      editors: [{ user: user("e1"), band: "overloaded", active: 3, dueSoon: 0 }],
      revisions: { thisWeek: 10, previousWeeks: [] },
      inactiveUserIds: ["gone"],
    });
    expect(kinds(all)).toEqual(["review", "editor_overloaded", "revision_spike", "unassigned_backlog", "stalled", "editor_unavailable", "review_overdue"]);
  });
});
