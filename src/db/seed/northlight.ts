/**
 * Northlight Studios demo history (ARCHITECTURE.md §12.6).
 *
 * 1. `buildSpecs()` lists the 160 jobs by FINAL bucket with their special
 *    cases (overdue, paused, reassigned mid-edit, reopened, …).
 * 2. `plan()` turns each spec into a timeline of service calls with
 *    relative gaps, then anchors it in real time (e.g. "submitted 30 h ago",
 *    "completed this week") so the end state matches the spec at real now.
 * 3. Editors are allocated once every timeline is placed (editor13 and
 *    editor11 only get work that fits before their deactivation).
 * 4. Every step is queued on the runtime with its absolute timestamp and
 *    executed in global time order through the real services, acting as
 *    the right person (photographer creates/reviews, editor accepts/starts/
 *    submits, managers assign/cancel/restore). Steps that act as "the
 *    editor" resolve the job's CURRENT editor at execution time, so
 *    deactivation hand-overs and automations are followed naturally.
 */
import { and, eq, isNull } from "drizzle-orm";
import { first } from "@/db/index";
import { jobLinks, jobNotes, jobs, users, workSessions } from "@/db/schema";
import { CATEGORY_GROUPS, DEFAULT_JOB_TYPES, type LinkKind, type NoteKind, type Priority } from "@/lib/constants";
import type { Job } from "@/lib/types";
import { addCivilDays, civilDate, startOfCivilDayIso } from "@/lib/dates";
import { createJob, setDueDate, setPriority, setReviewDueDate, pauseJob, resumeJob } from "@/server/services/jobs";
import {
  acceptJob,
  approveJob,
  beginReview,
  cancelJob,
  completeJob,
  declineJob,
  deliverJob,
  migrateWorkflow,
  reopenJob,
  restoreJob,
  startJob,
  submitJob,
  transitionJobStatus,
} from "@/server/services/workflow";
import { assignEditor } from "@/server/services/assignments";
import { requestRevision, resolveRevision } from "@/server/services/revisions";
import { addLink, replaceLink } from "@/server/services/links";
import { addNote, editNote } from "@/server/services/notes";
import { addComment, deleteComment, editComment } from "@/server/services/comments";
import { startTimer, stopTimer } from "@/server/services/timeTracking";
import { createProject } from "@/server/services/projects";
import {
  CANCEL_REASONS,
  CLIENT_NOTES,
  EDITOR_COMMENTS,
  EDITOR_NOTES,
  EDIT_SPAN_HOURS,
  INTERNAL_NOTES,
  JOB_NAME_SUFFIX,
  MANAGER_COMMENTS,
  PAUSE_REASONS,
  PHOTOGRAPHER_COMMENTS,
  PHOTOGRAPHER_NOTES,
  REPLY_COMMENTS,
  RESUBMIT_NOTES,
  REVISION_REQUESTS,
  STAFF,
  TURNAROUND_DAYS,
  TYPE_CLIENT_KIND,
  TYPE_WORKFLOW,
  type ClientKind,
  type JobTypeName,
  type SeedClientDef,
  type SeedProjectDef,
  type WorkflowKind,
} from "./catalog";
import type { WorkflowRefs } from "./org";
import { DAY, HOUR, MINUTE, type SeedRuntime } from "./runtime";
import type { Rng } from "./prng";

/* ------------------------------------------------------------------ */
/*  Specs                                                              */
/* ------------------------------------------------------------------ */

export type Final =
  | "new"
  | "ready"
  | "assigned"
  | "accepted"
  | "in_progress"
  | "submitted"
  | "review"
  | "revision"
  | "resubmitted"
  | "approved"
  | "delivered"
  | "completed"
  | "cancelled";

type CompletedWhen = "this_week" | "last_week" | "earlier";

export interface Spec {
  final: Final;
  type?: JobTypeName;
  /** Forced initial editor key. */
  editor?: string;
  revisions?: number;
  overdue?: boolean;
  dueSoon?: "today" | "tomorrow";
  /** Active jobs: due = today + n civil days. */
  dueInDays?: number;
  late?: boolean;
  paused?: boolean;
  pauseHistory?: boolean;
  timerBlocks?: number;
  runningTimer?: boolean;
  reassign?: boolean;
  decline?: { by: string; then: string };
  restore?: boolean;
  migrate?: boolean;
  finalCut?: boolean;
  dueChange?: "before" | "after_approval";
  reviewDue?: "past" | "extend";
  /** Age of the anchor (last step) in hours. */
  ageH?: readonly [number, number];
  completed?: CompletedWhen;
  reopen?: boolean;
  cancelFrom?: "new" | "ready" | "assigned" | "accepted" | "in_progress" | "submitted";
  replaceFinished?: boolean;
  replaceRaw?: boolean;
  estimatedHours?: number;
  priority?: Priority;
  /** editor13 holds the job when they are deactivated (10 days ago). */
  handoff13?: boolean;
  /** No activity after the anchor (stalled bottleneck). */
  stalled?: boolean;
  /** Use a project of a client that is archived at the end. */
  archivedClient?: boolean;
  noTypeFamily?: "quick";
}

const E = (n: number) => `editor${String(n).padStart(2, "0")}`;

/** The 160 Northlight jobs by final bucket (ARCHITECTURE.md §12.6). */
export function buildSpecs(): Spec[] {
  const s: Spec[] = [];
  const add = (n: number, spec: Spec) => {
    for (let i = 0; i < n; i++) s.push({ ...spec });
  };

  // new / ready — 12 (2 unassigned jobs due within 48 h, one stalled)
  add(1, { final: "new", dueSoon: "today", ageH: [2, 8] });
  add(4, { final: "new", ageH: [3, 60] });
  add(1, { final: "new", ageH: [0.5, 3] });
  add(1, { final: "ready", dueSoon: "tomorrow", ageH: [1, 20] });
  add(1, { final: "ready", stalled: true, ageH: [170, 215], dueInDays: 6 });
  add(4, { final: "ready", ageH: [1, 48] });

  // assigned / accepted — 14
  add(1, { final: "assigned", editor: E(3), dueSoon: "tomorrow", ageH: [2, 20] });
  add(1, { final: "assigned", editor: E(3), ageH: [3, 30] });
  add(1, { final: "assigned", decline: { by: E(4), then: E(6) }, ageH: [2, 20] });
  add(4, { final: "assigned", ageH: [1, 30] });
  add(1, { final: "accepted", editor: E(3), ageH: [2, 30] });
  add(1, { final: "accepted", editor: E(11), ageH: [80, 96], dueInDays: 5 });
  add(1, { final: "accepted", stalled: true, ageH: [150, 180], dueInDays: 7 });
  add(4, { final: "accepted", ageH: [1, 40] });

  // in_progress — 24
  add(2, { final: "in_progress", editor: E(3), dueSoon: "today", ageH: [2, 30], type: "Real Estate" });
  add(1, { final: "in_progress", editor: E(3), dueSoon: "tomorrow", ageH: [2, 30] });
  add(1, { final: "in_progress", editor: E(3), ageH: [2, 40], dueInDays: 4, timerBlocks: 1, type: "Real Estate" });
  add(1, { final: "in_progress", editor: E(3), ageH: [2, 40], dueInDays: 5, type: "Floor Plans" });
  s.push({ final: "in_progress", editor: E(7), type: "Wedding", estimatedHours: 12, priority: "normal", dueInDays: 14, ageH: [10, 60] });
  s.push({ final: "in_progress", editor: E(7), type: "Commercial", estimatedHours: 6, priority: "normal", dueInDays: 6, ageH: [4, 30] });
  s.push({ final: "in_progress", editor: E(7), type: "Real Estate", estimatedHours: 2, priority: "high", dueInDays: 3, ageH: [2, 20] });
  add(1, { final: "in_progress", editor: E(11), ageH: [84, 100], dueInDays: 3, type: "Real Estate" });
  add(1, { final: "in_progress", type: "Wedding", handoff13: true, dueInDays: 9 });
  add(1, { final: "in_progress", overdue: true, timerBlocks: 2, ageH: [8, 48] });
  add(1, { final: "in_progress", overdue: true, timerBlocks: 1, ageH: [8, 48] });
  add(1, { final: "in_progress", overdue: true, restore: true, ageH: [6, 40], type: "Real Estate" });
  add(1, { final: "in_progress", overdue: true, type: "Video", ageH: [10, 60] });
  add(1, { final: "in_progress", overdue: true, replaceRaw: true, ageH: [8, 48] });
  add(3, { final: "in_progress", overdue: true, ageH: [8, 60] });
  add(1, { final: "in_progress", paused: true, type: "Video", finalCut: true, ageH: [4, 48], dueInDays: 4 });
  add(1, { final: "in_progress", paused: true, replaceRaw: true, ageH: [4, 48], dueInDays: 3 });
  add(1, { final: "in_progress", runningTimer: true, editor: E(2), timerBlocks: 1, type: "Real Estate", ageH: [0.5, 0.7], dueInDays: 1 });
  add(1, { final: "in_progress", reassign: true, timerBlocks: 1, ageH: [2, 30], dueInDays: 2 });
  add(1, { final: "in_progress", reassign: true, dueChange: "before", ageH: [2, 30], dueInDays: 4 });
  add(1, { final: "in_progress", migrate: true, type: "Real Estate", timerBlocks: 1, ageH: [2, 24], dueInDays: 1 });

  // submitted / review — 16 (8 waiting > 24 h: 3 past review_due_date, 5 extended)
  add(2, { final: "submitted", reviewDue: "past", ageH: [28, 70] });
  add(1, { final: "submitted", editor: E(3), reviewDue: "extend", ageH: [30, 80] });
  add(1, { final: "submitted", reassign: true, reviewDue: "extend", ageH: [30, 70] });
  add(1, { final: "submitted", reviewDue: "extend", ageH: [30, 90] });
  add(1, { final: "submitted", editor: E(3), ageH: [1, 18] });
  s.push({ final: "submitted", editor: E(7), type: "Commercial", estimatedHours: 6, priority: "normal", dueInDays: 5, ageH: [1, 18] });
  add(1, { final: "submitted", dueChange: "before", ageH: [1, 18] });
  add(1, { final: "submitted", ageH: [1, 18] });
  add(1, { final: "review", reviewDue: "past", ageH: [28, 60] });
  add(2, { final: "review", reviewDue: "extend", ageH: [30, 70] });
  add(1, { final: "review", editor: E(3), ageH: [1, 12] });
  s.push({ final: "review", editor: E(7), type: "Product", estimatedHours: 3, priority: "normal", dueInDays: 4, ageH: [1, 12] });
  add(2, { final: "review", ageH: [1, 12] });

  // revision — 12 (4 at #2, 1 at #3, 3 overdue)
  add(1, { final: "revision", editor: E(3), revisions: 1, dueSoon: "today", ageH: [2, 30], type: "Real Estate" });
  add(1, { final: "revision", editor: E(3), revisions: 2, ageH: [3, 60], dueInDays: 3 });
  s.push({ final: "revision", editor: E(7), type: "Product", estimatedHours: 3, priority: "normal", revisions: 1, dueInDays: 4, ageH: [3, 40] });
  add(1, { final: "revision", revisions: 3, ageH: [110, 150] });
  add(2, { final: "revision", revisions: 2, ageH: [80, 130] });
  add(1, { final: "revision", revisions: 2, overdue: true, ageH: [6, 60] });
  add(2, { final: "revision", revisions: 1, overdue: true, ageH: [6, 60] });
  add(1, { final: "revision", revisions: 1, dueChange: "before", ageH: [50, 110] });
  add(2, { final: "revision", revisions: 1, ageH: [60, 120] });

  // resubmitted — 8
  add(1, { final: "resubmitted", editor: E(3), revisions: 1, ageH: [1, 20], dueInDays: 3 });
  s.push({ final: "resubmitted", editor: E(7), type: "Real Estate", estimatedHours: 2, priority: "normal", revisions: 1, dueInDays: 3, ageH: [1, 20] });
  add(2, { final: "resubmitted", revisions: 2, replaceFinished: true, ageH: [1, 28] });
  add(2, { final: "resubmitted", revisions: 1, replaceFinished: true, ageH: [1, 28] });
  add(2, { final: "resubmitted", revisions: 1, ageH: [1, 28] });

  // approved / delivered — 14
  add(1, { final: "approved", late: true, dueChange: "after_approval", ageH: [6, 60] });
  add(1, { final: "approved", late: true, ageH: [3, 100] });
  add(1, { final: "approved", reassign: true, ageH: [3, 100] });
  add(1, { final: "approved", handoff13: true, type: "Commercial" });
  add(1, { final: "approved", revisions: 1, ageH: [70, 110] });
  add(2, { final: "approved", ageH: [2, 110] });
  add(1, { final: "delivered", late: true, ageH: [2, 90] });
  add(2, { final: "delivered", revisions: 1, ageH: [70, 115] });
  add(1, { final: "delivered", revisions: 2, ageH: [75, 115] });
  add(3, { final: "delivered", ageH: [2, 90] });

  // completed — 52 (12 this week incl. 2 reopened + 1 editor13 hand-over; 10 last week; 30 earlier)
  add(2, { final: "completed", completed: "this_week", reopen: true });
  add(1, { final: "completed", completed: "this_week", handoff13: true, type: "Product" });
  add(2, { final: "completed", completed: "this_week", revisions: 1, timerBlocks: 1 });
  add(1, { final: "completed", completed: "this_week", revisions: 2, replaceFinished: true });
  add(1, { final: "completed", completed: "this_week", late: true });
  add(4, { final: "completed", completed: "this_week", timerBlocks: 1 });
  add(1, { final: "completed", completed: "this_week", revisions: 2 });
  add(3, { final: "completed", completed: "last_week", revisions: 1, timerBlocks: 1 });
  add(1, { final: "completed", completed: "last_week", revisions: 1, replaceFinished: true });
  add(1, { final: "completed", completed: "last_week", late: true });
  add(1, { final: "completed", completed: "last_week", reassign: true });
  add(4, { final: "completed", completed: "last_week" });
  add(3, { final: "completed", completed: "earlier", archivedClient: true });
  add(1, { final: "completed", completed: "earlier", decline: { by: E(9), then: E(1) } });
  add(1, { final: "completed", completed: "earlier", pauseHistory: true, timerBlocks: 1 });
  add(1, { final: "completed", completed: "earlier", dueChange: "before" });
  add(2, { final: "completed", completed: "earlier", late: true });
  add(1, { final: "completed", completed: "earlier", revisions: 3, replaceFinished: true });
  add(1, { final: "completed", completed: "earlier", revisions: 3 });
  add(2, { final: "completed", completed: "earlier", revisions: 2 });
  add(8, { final: "completed", completed: "earlier", revisions: 1 });
  add(1, { final: "completed", completed: "earlier", revisions: 1, replaceFinished: true });
  add(8, { final: "completed", completed: "earlier", timerBlocks: 1 });
  add(1, { final: "completed", completed: "earlier", revisions: 1, timerBlocks: 1 });

  // cancelled — 8
  add(2, { final: "cancelled", cancelFrom: "new", ageH: [24, 2000] });
  add(2, { final: "cancelled", cancelFrom: "ready", ageH: [24, 2000] });
  add(1, { final: "cancelled", cancelFrom: "assigned", ageH: [24, 1500] });
  add(1, { final: "cancelled", cancelFrom: "accepted", ageH: [24, 1500] });
  add(1, { final: "cancelled", cancelFrom: "in_progress", ageH: [24, 1500] });
  add(1, { final: "cancelled", cancelFrom: "submitted", ageH: [24, 1500] });

  return s;
}

/* ------------------------------------------------------------------ */
/*  Timeline model                                                     */
/* ------------------------------------------------------------------ */

type ActorRole = "photographer" | "editor" | "manager" | "reviewer" | "assigner" | "completer";

type StepDef =
  | { k: "create" }
  | { k: "link"; kind: LinkKind; actor: "photographer" | "editor" }
  | { k: "replaceLink"; slot: "raw" | "finished" }
  | { k: "note"; kind: NoteKind; actor: "photographer" | "editor" | "manager" }
  | { k: "noteEdit" }
  | { k: "migrate" }
  | { k: "ready" }
  | { k: "assign"; slot: "initial" | "after_decline" | "reassign" }
  | { k: "decline" }
  | { k: "accept" }
  | { k: "start" }
  | { k: "finalCut" }
  | { k: "timerStart" }
  | { k: "timerStop" }
  | { k: "pause" }
  | { k: "resume" }
  | { k: "cancel"; reason: string; actor: "photographer" | "manager" }
  | { k: "restore" }
  | { k: "submit" }
  | { k: "beginReview" }
  | { k: "revision"; n: number }
  | { k: "resubmit" }
  | { k: "approve" }
  | { k: "deliver" }
  | { k: "complete" }
  | { k: "reopen" }
  | { k: "setDue" }
  | { k: "setReviewDue"; days: number }
  | { k: "priority"; priority: Priority }
  | { k: "comment"; idx: number; role: "photographer" | "editor" | "manager"; reply: boolean; mention: boolean }
  | { k: "commentEdit"; idx: number }
  | { k: "commentDelete"; idx: number };

interface TimedStep {
  at: number;
  def: StepDef;
}

class Timeline {
  off = 0;
  readonly items: { off: number; def: StepDef }[] = [];

  add(def: StepDef, gapMs: number): number {
    this.off += Math.max(MINUTE, Math.round(gapMs));
    this.items.push({ off: this.off, def });
    return this.items.length - 1;
  }

  has(k: StepDef["k"]): boolean {
    return this.items.some((i) => i.def.k === k);
  }
}

interface ProjectRec {
  clientIdx: number;
  def: SeedProjectDef;
  id: string | null;
  uses: number;
  firstUseAt: number;
  creatorKey: string;
}

interface ClientRec {
  def: SeedClientDef;
  id: string;
  projects: ProjectRec[];
}

export interface JobPlan {
  n: number;
  spec: Spec;
  type: JobTypeName;
  wf0: WorkflowKind;
  photographerKey: string;
  creatorKey: string;
  managerKey: string;
  reviewerKey: string;
  assignerKey: string;
  completerKey: string;
  editors: string[];
  reassignTo: string | null;
  priority: Priority;
  estimatedHours: number | null;
  project: ProjectRec;
  name: string;
  description: string | null;
  steps: TimedStep[];
  shootCivil: string;
  dueCivil: string | null;
  dueInitialCivil: string | null;
  // runtime state
  jobId: string | null;
  rawLinkId: string | null;
  finishedLinkId: string | null;
  photographerNoteId: string | null;
  timerUserId: string | null;
  comments: ({ id: string; authorId: string } | null)[];
}

/* ------------------------------------------------------------------ */
/*  Seeder                                                             */
/* ------------------------------------------------------------------ */

export interface NorthlightRefs {
  organisationId: string;
  workflows: Record<WorkflowKind, WorkflowRefs>;
  jobTypes: Record<JobTypeName, string>;
  clients: { def: SeedClientDef; id: string }[];
}

const SLUG = "northlight";
const REGULAR_EDITORS = [1, 2, 4, 5, 6, 8, 9, 10, 12].map(E);
const AFFINITY: Record<ClientKind, readonly string[]> = {
  real_estate: [E(1), E(2), E(4), E(5), E(12)],
  wedding: [E(6), E(9), E(2)],
  commercial: [E(8), E(10), E(12), E(5)],
};
const PHOTOGRAPHERS_BY_TYPE: Record<JobTypeName, readonly string[]> = {
  "Real Estate": ["photographer01", "photographer02", "photographer03", "photographer12", "photographer04"],
  Drone: ["photographer04", "photographer04", "photographer01"],
  Twilight: ["photographer06", "photographer06", "photographer02"],
  "Floor Plans": ["photographer03", "photographer12", "photographer02"],
  "Virtual Staging": ["photographer01", "photographer12", "photographer03"],
  Wedding: ["photographer05", "photographer07", "photographer08"],
  Commercial: ["photographer09", "photographer11", "photographer10"],
  Product: ["photographer10", "photographer10", "photographer09"],
  Video: ["photographer11", "photographer11", "photographer09"],
  Retouching: ["photographer10", "photographer09"],
};
const TYPE_WEIGHTS: readonly (readonly [JobTypeName, number])[] = [
  ["Real Estate", 34],
  ["Drone", 8],
  ["Twilight", 7],
  ["Floor Plans", 6],
  ["Virtual Staging", 5],
  ["Retouching", 4],
  ["Wedding", 9],
  ["Commercial", 10],
  ["Product", 9],
  ["Video", 6],
];
const DEFAULT_TYPE_HOURS = Object.fromEntries(DEFAULT_JOB_TYPES.map((t) => [t.name, t.defaultEstimatedHours])) as Record<JobTypeName, number>;
const LONG_TYPES: ReadonlySet<JobTypeName> = new Set(["Wedding", "Commercial", "Video", "Product"]);

export class NorthlightSeeder {
  readonly plans: JobPlan[] = [];
  private readonly clients: ClientRec[];
  private readonly rng: Rng;
  private readonly tz = "Australia/Sydney";
  readonly today: string;
  readonly thisWeekStart: number;
  readonly lastWeekStart: number;
  readonly deactivate13At: number;
  readonly deactivate11At: number;
  private readonly firstJobAt: number;

  constructor(
    private readonly rt: SeedRuntime,
    private readonly refs: NorthlightRefs,
  ) {
    this.rng = rt.rng;
    const now = rt.nowMs;
    this.today = civilDate(new Date(now), this.tz) as string;
    const dow = new Date(`${this.today}T00:00:00Z`).getUTCDay();
    const monday = addCivilDays(this.today, -((dow + 6) % 7));
    this.thisWeekStart = Date.parse(startOfCivilDayIso(monday, this.tz));
    this.lastWeekStart = Date.parse(startOfCivilDayIso(addCivilDays(monday, -7), this.tz));
    this.deactivate13At = now - 10 * DAY;
    this.deactivate11At = now - 3 * DAY;
    this.firstJobAt = now - 121 * DAY;
    this.clients = refs.clients.map((c, clientIdx) => ({
      def: c.def,
      id: c.id,
      projects: c.def.projects.map((p) => ({ clientIdx, def: p, id: null, uses: 0, firstUseAt: Number.POSITIVE_INFINITY, creatorKey: "manager1" })),
    }));
  }

  private user(key: string): string {
    return this.rt.user(SLUG, key);
  }

  private civil(ms: number): string {
    return civilDate(new Date(ms), this.tz) as string;
  }

  /* ------------------------------ planning ------------------------------ */

  plan(specs: readonly Spec[]): void {
    const rng = this.rng;
    specs.forEach((spec, n) => {
      const type = this.pickType(spec);
      const wf0 = TYPE_WORKFLOW[type];
      const photographerKey = rng.pick(PHOTOGRAPHERS_BY_TYPE[type]);
      const managerKey = rng.chance(0.55) ? "manager1" : "manager2";
      const creatorKey = rng.chance(0.85) ? photographerKey : managerKey;
      const reviewerKey = rng.chance(0.75) ? photographerKey : managerKey;
      const assignerKey = rng.chance(0.6) ? managerKey : photographerKey;
      const completerKey = rng.chance(0.6) ? photographerKey : managerKey;
      const tl = this.buildTimeline(spec, type, wf0);
      const steps = this.place(spec, tl);
      const project = this.pickProject(spec, type);
      const suffix = rng.pick(JOB_NAME_SUFFIX[type]);
      const createdAt = steps[0]?.at ?? this.rt.nowMs;
      project.uses += 1;
      if (createdAt < project.firstUseAt) {
        project.firstUseAt = createdAt;
        project.creatorKey = creatorKey;
      }
      const plan: JobPlan = {
        n,
        spec,
        type,
        wf0,
        photographerKey,
        creatorKey,
        managerKey,
        reviewerKey,
        assignerKey,
        completerKey,
        editors: [],
        reassignTo: null,
        priority: spec.priority ?? rng.weighted<Priority>([["normal", 65], ["high", 20], ["low", 10], ["urgent", 5]]),
        estimatedHours: spec.estimatedHours ?? (rng.chance(0.15) ? Math.round(rng.range(1, 8) * 2) / 2 : null),
        project,
        name: `${project.def.name} · ${suffix}`,
        description: rng.chance(0.5) ? `${suffix} for ${this.clients[project.clientIdx]?.def.name ?? "the client"}.` : null,
        steps,
        shootCivil: this.civil(createdAt),
        dueCivil: null,
        dueInitialCivil: null,
        jobId: null,
        rawLinkId: null,
        finishedLinkId: null,
        photographerNoteId: null,
        timerUserId: null,
        comments: [],
      };
      this.computeDue(plan);
      this.plans.push(plan);
    });
    this.allocateEditors();
    for (const plan of this.plans) this.decorate(plan);
  }

  private pickType(spec: Spec): JobTypeName {
    if (spec.type) return spec.type;
    const needsFull =
      spec.final === "accepted" ||
      spec.final === "review" ||
      spec.final === "delivered" ||
      spec.cancelFrom === "accepted" ||
      spec.reopen === true;
    const longOk = !spec.dueSoon && !(spec.ageH && spec.ageH[1] < 2);
    const pool = TYPE_WEIGHTS.filter(([t]) => (!needsFull || TYPE_WORKFLOW[t] !== "quick") && (longOk || !LONG_TYPES.has(t)));
    let type = this.rng.weighted(pool);
    if (spec.archivedClient && TYPE_CLIENT_KIND[type] !== "real_estate") type = "Real Estate";
    return type;
  }

  private pickProject(spec: Spec, type: JobTypeName): ProjectRec {
    const kind = TYPE_CLIENT_KIND[type];
    const candidates = this.clients
      .filter((c) => c.def.kind === kind && (spec.archivedClient ? c.def.archived === true : c.def.archived !== true))
      .flatMap((c) => c.projects);
    const minUses = Math.min(...candidates.map((p) => p.uses));
    const least = candidates.filter((p) => p.uses === minUses);
    return this.rng.pick(least);
  }

  private hours(range: readonly [number, number]): number {
    return this.rng.range(range[0], range[1]) * HOUR;
  }

  private mins(a: number, b: number): number {
    return this.rng.range(a, b) * MINUTE;
  }

  private hrs(a: number, b: number): number {
    return this.rng.range(a, b) * HOUR;
  }

  /** The ordered service calls for one job, with relative gaps. */
  private buildTimeline(spec: Spec, type: JobTypeName, wf0: WorkflowKind): Timeline {
    const rng = this.rng;
    const tl = new Timeline();
    let wf: WorkflowKind = wf0;
    const final = spec.final;
    const cancelFrom = spec.cancelFrom;
    const cancel = (actor: "photographer" | "manager") => tl.add({ k: "cancel", reason: rng.pick(CANCEL_REASONS), actor }, this.hrs(2, 70));

    tl.add({ k: "create" }, 0);
    tl.add({ k: "link", kind: "raw_files", actor: "photographer" }, this.mins(4, 25));
    tl.add({ k: "note", kind: "photographer", actor: "photographer" }, this.mins(1, 20));
    // Every job carries at least two kinds of notes (photographer + client or internal).
    if (rng.chance(0.55)) tl.add({ k: "note", kind: "client", actor: "photographer" }, this.mins(2, 40));
    else tl.add({ k: "note", kind: "internal", actor: "manager" }, this.mins(10, 150));
    if (rng.chance(0.08)) tl.add({ k: "noteEdit" }, this.mins(5, 90));
    if (spec.migrate) {
      tl.add({ k: "migrate" }, this.hrs(0.3, 2));
      wf = "quick";
    }
    if (final === "new") return tl;
    if (cancelFrom === "new") {
      cancel(rng.chance(0.5) ? "photographer" : "manager");
      return tl;
    }
    const readyFirst = final === "ready" || cancelFrom === "ready" || spec.migrate === true || rng.chance(0.5);
    if (readyFirst) tl.add({ k: "ready" }, this.mins(10, 150));
    if (final === "ready") return tl;
    if (cancelFrom === "ready") {
      cancel("manager");
      return tl;
    }
    tl.add({ k: "assign", slot: "initial" }, this.hrs(0.2, 4));
    if (spec.decline) {
      tl.add({ k: "decline" }, this.hrs(0.3, 3));
      tl.add({ k: "assign", slot: "after_decline" }, this.hrs(0.2, 2));
    }
    if (final === "assigned") return tl;
    if (cancelFrom === "assigned") {
      cancel("manager");
      return tl;
    }
    const accept = wf !== "quick" && (final === "accepted" || cancelFrom === "accepted" || rng.chance(0.6));
    if (accept) tl.add({ k: "accept" }, this.hrs(0.2, 5));
    if (final === "accepted") return tl;
    if (cancelFrom === "accepted") {
      cancel("manager");
      return tl;
    }

    // ---- editing ----
    const span = this.hours(EDIT_SPAN_HOURS[type]);
    tl.add({ k: "start" }, this.hrs(0.2, 8));
    tl.add({ k: "link", kind: "editing_workspace", actor: "editor" }, this.mins(5, 25));
    if (rng.chance(0.4)) tl.add({ k: "note", kind: "editor", actor: "editor" }, this.mins(5, 40));
    let used = 0;
    const portion = (f: number) => {
      const g = Math.max(10 * MINUTE, span * f);
      used += g;
      return g;
    };
    if (spec.restore) {
      tl.add({ k: "cancel", reason: "Vendor paused the campaign", actor: "manager" }, portion(0.15));
      tl.add({ k: "restore" }, this.hrs(20, 50));
    }
    const blocks = spec.timerBlocks ?? 0;
    for (let i = 0; i < blocks; i++) {
      tl.add({ k: "timerStart" }, portion(0.12));
      tl.add({ k: "timerStop" }, Math.min(this.mins(40, 170), Math.max(30 * MINUTE, span * 0.3)));
    }
    if (spec.pauseHistory) {
      tl.add({ k: "pause" }, portion(0.15));
      tl.add({ k: "resume" }, this.hrs(5, 26));
    }
    if (spec.reassign) tl.add({ k: "assign", slot: "reassign" }, portion(0.2));
    if (spec.replaceRaw) tl.add({ k: "replaceLink", slot: "raw" }, portion(0.08));
    if (wf === "video" && (final !== "in_progress" || spec.finalCut)) tl.add({ k: "finalCut" }, portion(0.35));
    if (spec.dueChange === "before" && final === "in_progress") tl.add({ k: "setDue" }, portion(0.1));
    if (final === "in_progress") {
      if (spec.paused) tl.add({ k: "pause" }, portion(0.1));
      if (spec.runningTimer) tl.add({ k: "timerStart" }, portion(0.1));
      return tl;
    }
    if (cancelFrom === "in_progress") {
      tl.add({ k: "cancel", reason: rng.pick(CANCEL_REASONS), actor: "manager" }, portion(0.3));
      return tl;
    }
    tl.add({ k: "link", kind: "finished_files", actor: "editor" }, Math.max(15 * MINUTE, span - used));
    tl.add({ k: "submit" }, this.mins(3, 20));
    if (spec.dueChange === "before" && final === "submitted") tl.add({ k: "setDue" }, this.hrs(0.5, 4));
    if (cancelFrom === "submitted") {
      tl.add({ k: "cancel", reason: rng.pick(CANCEL_REASONS), actor: "manager" }, this.hrs(1, 20));
      return tl;
    }
    const hasReview = wf !== "quick";
    const revisions = spec.revisions ?? 0;
    for (let r = 1; r <= revisions; r++) {
      if (hasReview && rng.chance(0.5)) tl.add({ k: "beginReview" }, this.hrs(0.5, 12));
      tl.add({ k: "revision", n: r }, r === 1 ? this.hrs(0.3, 14) : this.hrs(20, 60));
      if (spec.dueChange === "before" && final === "revision" && r === revisions) tl.add({ k: "setDue" }, this.hrs(0.5, 6));
      if (final === "revision" && r === revisions) return tl;
      if (spec.replaceFinished && r === revisions) tl.add({ k: "replaceLink", slot: "finished" }, this.hrs(1, 12));
      tl.add({ k: "resubmit" }, final === "resubmitted" && r === revisions && rng.chance(0.6) ? this.hrs(60, 140) : this.hrs(0.5, 16));
      if (final === "resubmitted" && r === revisions) {
        tl.add({ k: "setReviewDue", days: rng.int(1, 3) }, this.hrs(0.5, 3));
        return tl;
      }
    }
    if (final === "submitted") {
      if (spec.reviewDue === "extend") tl.add({ k: "setReviewDue", days: rng.int(1, 3) }, this.hrs(25, 30));
      return tl;
    }
    if (final === "review") {
      tl.add({ k: "beginReview" }, this.hrs(0.5, 5));
      if (spec.reviewDue === "extend") tl.add({ k: "setReviewDue", days: rng.int(1, 3) }, this.hrs(25, 28));
      return tl;
    }
    if (hasReview && rng.chance(0.55)) tl.add({ k: "beginReview" }, this.hrs(0.5, 16));
    tl.add({ k: "approve" }, spec.late ? this.hrs(26, 50) : this.hrs(0.4, 20));
    if (spec.dueChange === "after_approval") tl.add({ k: "setDue" }, this.hrs(2, 30));
    if (final === "approved") return tl;
    const deliver = wf === "default" && (final === "delivered" || (final === "completed" && rng.chance(0.5)));
    if (deliver) {
      tl.add({ k: "link", kind: "client_delivery", actor: "photographer" }, this.hrs(0.5, 10));
      tl.add({ k: "link", kind: "gallery", actor: "photographer" }, this.mins(3, 30));
      tl.add({ k: "deliver" }, this.mins(3, 30));
    }
    if (final === "delivered") return tl;
    tl.add({ k: "complete" }, this.hrs(1, 40));
    if (spec.reopen) {
      tl.add({ k: "reopen" }, this.hrs(5, 20));
      tl.add({ k: "submit" }, this.hrs(2, 6));
      tl.add({ k: "approve" }, this.hrs(1, 5));
      tl.add({ k: "complete" }, this.hrs(1, 6));
    }
    if (spec.dueChange === "before" && final === "completed") {
      // Due date moved while the job was still being edited (before approval).
      const approveIdx = tl.items.findIndex((i) => i.def.k === "approve");
      if (approveIdx > 0) {
        const at = tl.items[approveIdx - 1]?.off ?? 0;
        tl.items.splice(approveIdx, 0, { off: at + MINUTE, def: { k: "setDue" } });
      }
    }
    return tl;
  }

  /** Anchors a timeline in real time so the end state matches the spec at real now. */
  private place(spec: Spec, tl: Timeline): TimedStep[] {
    const now = this.rt.nowMs;
    const rng = this.rng;
    const items = tl.items;
    const lastOff = items[items.length - 1]?.off ?? 0;
    let anchorIdx = items.length - 1;
    let anchorAt: number;

    if (spec.handoff13) {
      // editor13 starts the job ~1–2 days before their deactivation (10 days ago).
      anchorIdx = items.findIndex((i) => i.def.k === "start");
      anchorAt = this.deactivate13At - this.hrs(30, 50);
    } else if (spec.final === "completed" && spec.reopen) {
      // First completion last week, re-completed this week.
      const firstComplete = items.findIndex((i) => i.def.k === "complete");
      const chain = lastOff - (items[firstComplete]?.off ?? 0);
      const room = now - 10 * MINUTE - this.thisWeekStart;
      const delta = Math.max(5 * MINUTE, Math.min(room, chain - HOUR, rng.range(0.3, 0.9) * chain));
      anchorAt = this.thisWeekStart + delta;
    } else if (spec.final === "completed") {
      const when = spec.completed ?? "earlier";
      if (when === "this_week") anchorAt = rng.range(this.thisWeekStart + 5 * MINUTE, now - 10 * MINUTE);
      else if (when === "last_week") anchorAt = rng.range(this.lastWeekStart + HOUR, this.thisWeekStart - HOUR);
      else if ((spec.revisions ?? 0) > 0) anchorAt = rng.range(now - 38 * DAY, this.lastWeekStart - 2 * HOUR);
      else anchorAt = rng.range(now - 112 * DAY, this.lastWeekStart - 2 * HOUR);
    } else {
      const age = spec.ageH ?? [2, 48];
      anchorAt = now - rng.range(age[0], age[1]) * HOUR;
    }

    const base = anchorAt - (items[anchorIdx]?.off ?? 0);
    let steps = items.map((i) => ({ at: base + i.off, def: i.def }));

    // Never before the first job day; long completed jobs slide forward.
    const first = steps[0]?.at ?? now;
    if (first < this.firstJobAt) {
      const shift = this.firstJobAt - first + rng.range(0, 3) * DAY;
      steps = steps.map((s) => ({ ...s, at: s.at + shift }));
    }
    // Completed "earlier" must stay before last week; this-week jobs inside this week.
    if (spec.final === "completed" && !spec.reopen) {
      const last = steps[steps.length - 1] as TimedStep;
      const when = spec.completed ?? "earlier";
      const [lo, hi] =
        when === "this_week"
          ? [this.thisWeekStart + 5 * MINUTE, now - 5 * MINUTE]
          : when === "last_week"
            ? [this.lastWeekStart + 30 * MINUTE, this.thisWeekStart - 30 * MINUTE]
            : [this.firstJobAt, this.lastWeekStart - HOUR];
      if (last.at < lo || last.at > hi) {
        const prev = steps[steps.length - 2]?.at ?? 0;
        last.at = Math.max(prev + 30 * MINUTE, rng.range(lo, hi));
      }
    }
    // Handed-over jobs: everything after the hand-over must happen before now.
    if (spec.handoff13 && spec.final === "completed") {
      const last = steps[steps.length - 1] as TimedStep;
      const prev = steps[steps.length - 2]?.at ?? 0;
      last.at = Math.max(prev + HOUR, rng.range(this.thisWeekStart + 5 * MINUTE, now - 10 * MINUTE));
    }
    // Overdue jobs need a creation day before today.
    if (spec.overdue && this.civil(steps[0]?.at ?? now) >= this.today) {
      steps = steps.map((s) => ({ ...s, at: s.at - 30 * HOUR }));
    }
    // Everything strictly in the past.
    const lastAt = steps[steps.length - 1]?.at ?? now;
    const limit = now - 2 * MINUTE;
    if (lastAt > limit) {
      const anchorTime = steps[anchorIdx]?.at ?? lastAt;
      const factor = Math.max(0.05, (limit - anchorTime) / Math.max(1, lastAt - anchorTime));
      steps = steps.map((s, i) => (i > anchorIdx ? { ...s, at: anchorTime + (s.at - anchorTime) * factor } : s));
    }
    return steps.map((s) => ({ at: Math.round(s.at), def: s.def }));
  }

  private stepAt(plan: JobPlan, k: StepDef["k"], which: "first" | "last" = "first"): number | null {
    const list = plan.steps.filter((s) => s.def.k === k);
    const s = which === "first" ? list[0] : list[list.length - 1];
    return s ? s.at : null;
  }

  private computeDue(plan: JobPlan): void {
    const spec = plan.spec;
    const rng = this.rng;
    const createAt = plan.steps[0]?.at ?? this.rt.nowMs;
    const shoot = this.civil(createAt);
    const base = addCivilDays(shoot, TURNAROUND_DAYS[plan.type]);
    const max = (a: string, b: string) => (a > b ? a : b);
    const min = (a: string, b: string) => (a < b ? a : b);
    let due: string;
    const done = spec.final === "approved" || spec.final === "delivered" || spec.final === "completed";
    if (done) {
      const approveAt = this.stepAt(plan, "approve", "last") ?? createAt;
      const approveCivil = this.civil(approveAt);
      if (spec.late && !spec.reopen) due = max(shoot, addCivilDays(approveCivil, -1));
      else due = max(base, addCivilDays(approveCivil, rng.int(0, 1)));
    } else if (spec.final === "cancelled") {
      due = base;
    } else if (spec.overdue) {
      due = min(addCivilDays(this.today, -rng.int(1, 3)), max(shoot, base));
      if (due < shoot) due = shoot;
    } else if (spec.dueSoon === "today") {
      due = this.today;
    } else if (spec.dueSoon === "tomorrow") {
      due = addCivilDays(this.today, 1);
    } else if (spec.dueInDays !== undefined) {
      due = addCivilDays(this.today, spec.dueInDays);
    } else {
      const extra = LONG_TYPES.has(plan.type) ? rng.int(4, 12) : rng.int(2, 5);
      due = max(base, addCivilDays(this.today, extra));
    }
    plan.shootCivil = shoot;
    plan.dueCivil = due;
    if (spec.dueChange === "after_approval") {
      // Late at approval; the deadline is moved afterwards (on-time stays "as of approval").
      plan.dueInitialCivil = due;
      plan.dueCivil = addCivilDays(this.civil(this.stepAt(plan, "approve") ?? createAt), 3);
    } else if (spec.dueChange === "before") {
      plan.dueInitialCivil = max(shoot, addCivilDays(due, -2));
      if (plan.dueInitialCivil === due) plan.dueInitialCivil = addCivilDays(due, -1);
    }
  }

  /** Editors are chosen once timelines are placed (editor13 / editor11 only before they leave). */
  private allocateEditors(): void {
    // Expected workload contribution (hours × category weight), balanced against capacity.
    const capacity = new Map(STAFF.filter((u) => u.role === "editor").map((u) => [u.key, u.capacityHoursPerWeek ?? 38]));
    const load = new Map<string, number>(REGULAR_EDITORS.map((e) => [e, 0]));
    const categoryWeight: Partial<Record<Final, number>> = {
      assigned: 1,
      accepted: 1,
      in_progress: 1,
      revision: 1,
      submitted: 0.25,
      review: 0.25,
      resubmitted: 0.25,
      approved: 0.05,
      delivered: 0.05,
    };
    const weightOf = (plan: JobPlan) =>
      (plan.estimatedHours ?? DEFAULT_TYPE_HOURS[plan.type]) * (categoryWeight[plan.spec.final] ?? 0) * (plan.spec.overdue ? 1.5 : 1);
    // Overdue jobs are spread (3 overdue would force the overloaded band on anyone).
    const overdue = new Map<string, number>();
    const addLoad = (editor: string, plan: JobPlan) => {
      if (load.has(editor)) load.set(editor, (load.get(editor) ?? 0) + weightOf(plan));
      if (plan.spec.overdue) overdue.set(editor, (overdue.get(editor) ?? 0) + 1);
    };
    const ratio = (e: string, extra = 0) => ((load.get(e) ?? 0) + extra) / (capacity.get(e) ?? 38);
    const leastLoaded = (pool: readonly string[], plan: JobPlan, exclude: readonly string[] = []) => {
      const w = weightOf(plan);
      let candidates = pool.filter((e) => !exclude.includes(e));
      if (Math.min(...candidates.map((e) => ratio(e, w))) > 0.5) candidates = REGULAR_EDITORS.filter((e) => !exclude.includes(e));
      if (plan.spec.overdue) {
        const fewest = Math.min(...REGULAR_EDITORS.map((e) => overdue.get(e) ?? 0));
        const spread = candidates.filter((e) => (overdue.get(e) ?? 0) === fewest);
        candidates = spread.length > 0 ? spread : REGULAR_EDITORS.filter((e) => (overdue.get(e) ?? 0) === fewest && !exclude.includes(e));
      }
      const best = Math.min(...candidates.map((e) => ratio(e, w)));
      return this.rng.pick(candidates.filter((e) => ratio(e, w) <= best + 1e-9));
    };
    const needsEditor = (p: JobPlan) => p.steps.some((s) => s.def.k === "assign");

    // Fixed allocations first so the least-loaded picks see them.
    for (const plan of this.plans) {
      const spec = plan.spec;
      if (!needsEditor(plan)) continue;
      if (spec.handoff13) {
        plan.editors = [E(13)];
        addLoad(E(5), plan);
      } else if (spec.decline) {
        plan.editors = [spec.decline.by, spec.decline.then];
      } else if (spec.editor) {
        plan.editors = [spec.editor];
      }
      const last = plan.editors[plan.editors.length - 1];
      if (last && !spec.reassign) addLoad(last, plan);
    }
    // Biggest jobs first so they spread evenly.
    const open = this.plans
      .filter((p) => needsEditor(p) && p.editors.length === 0)
      .sort((a, b) => weightOf(b) - weightOf(a) || a.n - b.n);
    for (const plan of open) {
      const spec = plan.spec;
      const kind = TYPE_CLIENT_KIND[plan.type];
      const lastAt = plan.steps[plan.steps.length - 1]?.at ?? this.rt.nowMs;
      const terminal = spec.final === "completed" || spec.final === "cancelled";
      if (terminal) {
        const pool: [string, number][] = AFFINITY[kind].map((e) => [e, 3]);
        pool.push([E(3), 1.5], [E(7), 1.5]);
        if (lastAt < this.deactivate13At - 12 * HOUR) pool.push([E(13), 4]);
        if (lastAt < this.deactivate11At - 12 * HOUR) pool.push([E(11), 3]);
        plan.editors = [this.rng.weighted(pool)];
      } else {
        const editor = leastLoaded(AFFINITY[kind], plan);
        plan.editors = [editor];
        if (!spec.reassign) addLoad(editor, plan);
      }
    }
    for (const plan of this.plans) {
      if (!plan.spec.reassign) continue;
      const kind = TYPE_CLIENT_KIND[plan.type];
      const first = plan.editors[0] ?? "";
      if (plan.spec.final === "completed") {
        plan.reassignTo = this.rng.pick(AFFINITY[kind].filter((e) => e !== first));
      } else {
        plan.reassignTo = leastLoaded(AFFINITY[kind], plan, [first]);
        addLoad(plan.reassignTo, plan);
      }
    }
  }

  /** Comments, priority bumps and note edits sprinkled over the job's life. */
  private decorate(plan: JobPlan): void {
    const rng = this.rng;
    const now = this.rt.nowMs;
    const spec = plan.spec;
    const createAt = plan.steps[0]?.at ?? now;
    const lastAt = plan.steps[plan.steps.length - 1]?.at ?? now;
    const active = !["completed", "cancelled", "approved", "delivered"].includes(spec.final);
    const windowEnd = spec.stalled
      ? lastAt - MINUTE
      : spec.final === "cancelled"
        ? lastAt - MINUTE
        : Math.min(lastAt + (active ? 30 : 10) * HOUR, now - 10 * MINUTE);
    const windowStart = createAt + 15 * MINUTE;
    const count =
      spec.final === "cancelled" ? rng.int(0, 2) : active ? rng.int(1, 6) : spec.final === "completed" ? rng.int(0, 4) : rng.int(0, 5);
    if (windowEnd > windowStart + 10 * MINUTE) {
      const times = Array.from({ length: count }, () => rng.range(windowStart, windowEnd)).sort((a, b) => a - b);
      const assignAt = this.stepAt(plan, "assign") ?? Number.POSITIVE_INFINITY;
      times.forEach((at, idx) => {
        const reply = idx > 0 && rng.chance(0.2);
        const mention = rng.chance(0.1);
        const editorPossible = at > assignAt + 10 * MINUTE;
        const role = rng.weighted<"photographer" | "editor" | "manager">([
          ["photographer", 4],
          ["editor", editorPossible ? 4 : 0],
          ["manager", 2],
        ]);
        plan.steps.push({ at, def: { k: "comment", idx, role, reply, mention } });
        if (rng.chance(0.05)) plan.steps.push({ at: at + this.mins(2, 12), def: { k: "commentEdit", idx } });
        else if (rng.chance(0.015)) plan.steps.push({ at: Math.min(at + this.mins(20, 120), now - MINUTE), def: { k: "commentDelete", idx } });
      });
    }
    // Managers bump the priority of some open jobs (never the engineered editor03 / editor07 load).
    const engineered = spec.editor === E(3) || spec.editor === E(7) || spec.priority !== undefined;
    if (active && !engineered && !spec.stalled && rng.chance(0.15) && lastAt - createAt > HOUR) {
      plan.steps.push({ at: rng.range(createAt + 20 * MINUTE, lastAt), def: { k: "priority", priority: rng.chance(0.6) ? "high" : "urgent" } });
    }
    plan.steps.sort((a, b) => a.at - b.at);
  }

  /* ------------------------------ scheduling ------------------------------ */

  schedule(): void {
    for (const plan of this.plans) {
      plan.steps.forEach((step, i) => {
        this.rt.schedule(step.at, `#${plan.n} ${plan.spec.final} ${step.def.k}${i === 0 ? ` (${plan.type})` : ""}`, () => this.exec(plan, step.def));
      });
    }
    // Projects are created just before their first job (or at setup when unused).
    for (const client of this.clients) {
      for (const project of client.projects) {
        const at = Number.isFinite(project.firstUseAt) ? project.firstUseAt - this.mins(15, 90) : this.rt.nowMs - 126 * DAY + this.mins(10, 600);
        this.rt.schedule(at, `project ${project.def.name}`, async () => {
          const actor = this.user(project.creatorKey);
          const row = await this.rt.act(actor, (tx, ctx) =>
            createProject(tx, ctx, {
              clientId: client.id,
              name: project.def.name,
              address: project.def.address ?? null,
              description: project.def.description ?? null,
            }),
          );
          project.id = row.id;
        });
      }
    }
  }

  /* ------------------------------ execution ------------------------------ */

  /** Current job row, read on the root db (call it OUTSIDE act(): never inside its transaction). */
  private async job(plan: JobPlan): Promise<Job> {
    const id = plan.jobId;
    if (!id) throw new Error(`seed: job #${plan.n} not created yet`);
    const row = await first(this.rt.db.select().from(jobs).where(eq(jobs.id, id)));
    if (!row) throw new Error(`seed: job #${plan.n} missing`);
    return row;
  }

  private async currentEditor(plan: JobPlan): Promise<string | null> {
    return (await this.job(plan)).editorId;
  }

  private async actorFor(plan: JobPlan, role: ActorRole): Promise<string | null> {
    switch (role) {
      case "photographer":
        return this.user(plan.photographerKey);
      case "manager":
        return this.user(plan.managerKey);
      case "reviewer":
        return this.user(plan.reviewerKey);
      case "assigner":
        return this.user(plan.assignerKey);
      case "completer":
        return this.user(plan.completerKey);
      case "editor":
        return this.currentEditor(plan);
    }
  }

  private async requireActor(plan: JobPlan, role: ActorRole): Promise<string> {
    const id = await this.actorFor(plan, role);
    if (!id) throw new Error(`seed: job #${plan.n} has no ${role}`);
    return id;
  }

  private url(plan: JobPlan, kind: LinkKind): string {
    const t = this.rng.token(12);
    const slug = plan.project.def.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
    switch (kind) {
      case "raw_files":
        return `https://www.dropbox.com/scl/fo/${t}/${slug}-raw`;
      case "editing_workspace":
        return plan.type === "Video" ? `https://app.frame.io/projects/${t}` : `https://lightroom.adobe.com/shares/${t}`;
      case "finished_files":
        return `https://drive.google.com/drive/folders/${t}`;
      case "gallery":
        return `https://northlight.pixieset.com/${slug}-${t.slice(0, 5)}`;
      case "client_delivery":
        return `https://we.tl/t-${t}`;
      default:
        return `https://www.dropbox.com/scl/fi/${t}/${slug}`;
    }
  }

  private async exec(plan: JobPlan, def: StepDef): Promise<void> {
    const rt = this.rt;
    const rng = this.rng;
    const wf = this.refs.workflows;
    if (def.k === "create") {
      const creator = this.user(plan.creatorKey);
      const project = plan.project;
      if (!project.id) throw new Error(`seed: project ${project.def.name} not created`);
      const result = await rt.act(creator, (tx, ctx) =>
        createJob(tx, ctx, {
          name: plan.name,
          description: plan.description,
          projectId: project.id,
          jobTypeId: this.refs.jobTypes[plan.type],
          priority: plan.priority,
          photographerId: this.user(plan.photographerKey),
          shootDate: plan.shootCivil,
          dueDate: plan.dueInitialCivil ?? plan.dueCivil,
          estimatedHours: plan.estimatedHours,
        }),
      );
      plan.jobId = result.job.id;
      return;
    }
    const jobId = plan.jobId;
    if (!jobId) throw new Error(`seed: job #${plan.n} not created before ${def.k}`);
    const version = async () => (await this.job(plan)).version;

    switch (def.k) {
      case "link": {
        const actor = def.actor === "editor" ? await this.currentEditor(plan) : this.user(plan.photographerKey);
        if (!actor) return rt.skip(`#${plan.n} link ${def.kind}: no editor`);
        const link = await rt.act(actor, (tx, ctx) => addLink(tx, ctx, { jobId, kind: def.kind, url: this.url(plan, def.kind), label: null }));
        if (def.kind === "raw_files") plan.rawLinkId = link.id;
        if (def.kind === "finished_files") plan.finishedLinkId = link.id;
        return;
      }
      case "replaceLink": {
        const linkId = def.slot === "raw" ? plan.rawLinkId : plan.finishedLinkId;
        if (!linkId) return rt.skip(`#${plan.n} replace ${def.slot}: no link`);
        const link = await first(rt.db.select().from(jobLinks).where(eq(jobLinks.id, linkId)));
        const editor = await this.currentEditor(plan);
        const actor = link && editor && link.addedByUserId === editor && (await this.job(plan)).statusCategory !== "completed" ? editor : this.user(plan.photographerKey);
        const kind: LinkKind = def.slot === "raw" ? "raw_files" : "finished_files";
        const result = await rt.act(actor, (tx, ctx) => replaceLink(tx, ctx, { linkId, url: this.url(plan, kind) }));
        if (def.slot === "raw") plan.rawLinkId = result.link.id;
        else plan.finishedLinkId = result.link.id;
        return;
      }
      case "note": {
        const actor = def.actor === "editor" ? await this.currentEditor(plan) : await this.actorFor(plan, def.actor);
        if (!actor) return rt.skip(`#${plan.n} note ${def.kind}: no actor`);
        const pool = def.kind === "photographer" ? PHOTOGRAPHER_NOTES : def.kind === "client" ? CLIENT_NOTES : def.kind === "internal" ? INTERNAL_NOTES : EDITOR_NOTES;
        const note = await rt.act(actor, (tx, ctx) => addNote(tx, ctx, { jobId, kind: def.kind, body: rng.pick(pool), isPinned: def.kind === "client" && rng.chance(0.3) }));
        if (def.kind === "photographer" && !plan.photographerNoteId) plan.photographerNoteId = note.id;
        return;
      }
      case "noteEdit": {
        const noteId = plan.photographerNoteId;
        if (!noteId) return rt.skip(`#${plan.n} noteEdit: no note`);
        const note = await first(rt.db.select().from(jobNotes).where(eq(jobNotes.id, noteId)));
        if (!note) return;
        await rt.act(this.user(plan.photographerKey), (tx, ctx) =>
          editNote(tx, ctx, { noteId, expectedVersion: note.version, body: `${note.body} Update: agent added two extra frames of the garden.` }),
        );
        return;
      }
      case "migrate": {
        const v = await version();
        await rt.act(this.user(plan.managerKey), (tx, ctx) =>
          migrateWorkflow(tx, ctx, {
            jobId,
            workflowId: wf.quick.id,
            toStatusId: wf.quick.statuses.new,
            expectedVersion: v,
            reason: "Client only needs a quick retouch of the hero images",
          }),
        );
        return;
      }
      case "ready": {
        const v = await version();
        await rt.act(this.user(plan.photographerKey), (tx, ctx) => transitionJobStatus(tx, ctx, { jobId, toCategory: "ready", expectedVersion: v }));
        return;
      }
      case "assign": {
        const editorKey = def.slot === "reassign" ? plan.reassignTo : def.slot === "after_decline" ? plan.editors[1] : plan.editors[0];
        if (!editorKey) throw new Error(`seed: job #${plan.n} has no editor for ${def.slot}`);
        const actor = def.slot === "initial" ? this.user(plan.assignerKey) : this.user(plan.managerKey);
        const reason =
          def.slot === "reassign" ? "Rebalancing workload" : def.slot === "after_decline" ? "Reassigned after decline" : null;
        const v = await version();
        await rt.act(actor, (tx, ctx) => assignEditor(tx, ctx, { jobId, userId: this.user(editorKey), reason, expectedVersion: v }));
        return;
      }
      case "decline": {
        const editor = await this.requireActor(plan, "editor");
        const v = await version();
        await rt.act(editor, (tx, ctx) => declineJob(tx, ctx, { jobId, expectedVersion: v, reason: "Fully booked this week, sorry" }));
        return;
      }
      case "accept": {
        const v = await version();
        await rt.act(await this.requireActor(plan, "editor"), (tx, ctx) => acceptJob(tx, ctx, { jobId, expectedVersion: v }));
        return;
      }
      case "start": {
        const job = await this.job(plan);
        const toStatusId = job.workflowId === wf.video.id ? wf.video.statuses.in_progress : undefined;
        const v = await version();
        await rt.act(await this.requireActor(plan, "editor"), (tx, ctx) => startJob(tx, ctx, { jobId, expectedVersion: v, toStatusId }));
        return;
      }
      case "finalCut": {
        const finalCut = wf.video.statuses.final_cut;
        if (!finalCut || (await this.job(plan)).workflowId !== wf.video.id) return rt.skip(`#${plan.n} finalCut: not a video job`);
        const v = await version();
        await rt.act(await this.requireActor(plan, "editor"), (tx, ctx) => transitionJobStatus(tx, ctx, { jobId, toStatusId: finalCut, expectedVersion: v }));
        return;
      }
      case "timerStart": {
        const job = await this.job(plan);
        const editor = job.editorId;
        if (!editor || job.isPaused || !CATEGORY_GROUPS.EDITOR_WORKING.includes(job.statusCategory) || !(await rt.isActive(editor))) {
          return rt.skip(`#${plan.n} timerStart: not workable`);
        }
        await rt.act(editor, (tx, ctx) => startTimer(tx, ctx, { jobId, switchFromRunning: true }));
        plan.timerUserId = editor;
        return;
      }
      case "timerStop": {
        const userId = plan.timerUserId;
        if (!userId) return;
        const running = await first(
          rt.db
            .select({ id: workSessions.id })
            .from(workSessions)
            .where(and(eq(workSessions.jobId, jobId), eq(workSessions.userId, userId), isNull(workSessions.endedAt)))
            .limit(1),
        );
        if (!running || !(await rt.isActive(userId))) return;
        await rt.act(userId, (tx, ctx) => stopTimer(tx, ctx, { jobId }));
        return;
      }
      case "pause": {
        const v = await version();
        await rt.act(await this.requireActor(plan, "editor"), (tx, ctx) => pauseJob(tx, ctx, { jobId, expectedVersion: v, reason: rng.pick(PAUSE_REASONS) }));
        return;
      }
      case "resume": {
        const v = await version();
        await rt.act(await this.requireActor(plan, "editor"), (tx, ctx) => resumeJob(tx, ctx, { jobId, expectedVersion: v }));
        return;
      }
      case "cancel": {
        const actor = def.actor === "manager" ? this.user(plan.managerKey) : this.user(plan.photographerKey);
        const v = await version();
        await rt.act(actor, (tx, ctx) => cancelJob(tx, ctx, { jobId, expectedVersion: v, reason: def.reason }));
        return;
      }
      case "restore": {
        const v = await version();
        await rt.act(this.user(plan.managerKey), (tx, ctx) => restoreJob(tx, ctx, { jobId, expectedVersion: v, reason: "Vendor is going ahead after all" }));
        return;
      }
      case "submit": {
        const v = await version();
        await rt.act(await this.requireActor(plan, "editor"), (tx, ctx) => submitJob(tx, ctx, { jobId, expectedVersion: v }));
        return;
      }
      case "beginReview": {
        const v = await version();
        await rt.act(this.user(plan.reviewerKey), (tx, ctx) => beginReview(tx, ctx, { jobId, expectedVersion: v }));
        return;
      }
      case "revision": {
        const req = rng.pick(REVISION_REQUESTS);
        const v = await version();
        await rt.act(this.user(plan.reviewerKey), (tx, ctx) =>
          requestRevision(tx, ctx, {
            jobId,
            expectedVersion: v,
            reason: req.reason,
            description: req.description,
            instructions: req.instructions,
            dueDate: addCivilDays(this.civil(Date.parse(ctx.now())), rng.int(1, 2)),
          }),
        );
        return;
      }
      case "resubmit": {
        const job = await this.job(plan);
        if (!job.openRevisionId) throw new Error(`seed: job #${plan.n} has no open revision to resubmit`);
        const revisionId = job.openRevisionId;
        await rt.act(await this.requireActor(plan, "editor"), (tx, ctx) =>
          resolveRevision(tx, ctx, { revisionId, expectedVersion: job.version, note: rng.pick(RESUBMIT_NOTES) }),
        );
        return;
      }
      case "approve": {
        const v = await version();
        await rt.act(this.user(plan.reviewerKey), (tx, ctx) => approveJob(tx, ctx, { jobId, expectedVersion: v }));
        return;
      }
      case "deliver": {
        const v = await version();
        await rt.act(this.user(plan.photographerKey), (tx, ctx) => deliverJob(tx, ctx, { jobId, expectedVersion: v }));
        return;
      }
      case "complete": {
        const v = await version();
        await rt.act(this.user(plan.completerKey), (tx, ctx) => completeJob(tx, ctx, { jobId, expectedVersion: v }));
        return;
      }
      case "reopen": {
        const v = await version();
        await rt.act(this.user(plan.photographerKey), (tx, ctx) =>
          reopenJob(tx, ctx, { jobId, expectedVersion: v, reason: "Agent spotted a missing room after delivery", toCategory: "in_progress" }),
        );
        return;
      }
      case "setDue": {
        const value = plan.dueCivil;
        if (!value) return;
        const v = await version();
        await rt.act(this.user(plan.managerKey), (tx, ctx) => setDueDate(tx, ctx, { jobId, expectedVersion: v, value }));
        return;
      }
      case "setReviewDue": {
        const value = addCivilDays(this.today, def.days);
        const v = await version();
        await rt.act(this.user(plan.photographerKey), (tx, ctx) => setReviewDueDate(tx, ctx, { jobId, expectedVersion: v, value }));
        return;
      }
      case "priority": {
        if ((await this.job(plan)).priority === def.priority) return;
        const v = await version();
        await rt.act(this.user(plan.managerKey), (tx, ctx) => setPriority(tx, ctx, { jobId, expectedVersion: v, priority: def.priority }));
        return;
      }
      case "comment":
        return this.execComment(plan, def);
      case "commentEdit": {
        const c = plan.comments[def.idx];
        if (!c || !(await rt.isActive(c.authorId))) return;
        const job = await this.job(plan);
        const author = c.authorId;
        if (job.editorId !== author && author !== this.user(plan.photographerKey) && author !== this.user(plan.managerKey)) return;
        await rt.act(author, (tx, ctx) => editComment(tx, ctx, { commentId: c.id, body: `${rng.pick(PHOTOGRAPHER_COMMENTS)} (edited: typo)` }));
        return;
      }
      case "commentDelete": {
        const c = plan.comments[def.idx];
        if (!c || !(await rt.isActive(c.authorId))) return;
        const job = await this.job(plan);
        if (job.editorId !== c.authorId && c.authorId !== this.user(plan.photographerKey) && c.authorId !== this.user(plan.managerKey)) return;
        await rt.act(c.authorId, (tx, ctx) => deleteComment(tx, ctx, { commentId: c.id }));
        plan.comments[def.idx] = null;
        return;
      }
      default: {
        const never: never = def;
        throw new Error(`seed: unknown step ${JSON.stringify(never)}`);
      }
    }
  }

  private async execComment(plan: JobPlan, def: Extract<StepDef, { k: "comment" }>): Promise<void> {
    const rt = this.rt;
    const rng = this.rng;
    const jobId = plan.jobId as string;
    const job = await this.job(plan);
    const photographer = this.user(plan.photographerKey);
    const manager = this.user(plan.managerKey);
    const editor = job.editorId && (await rt.isActive(job.editorId)) ? job.editorId : null;
    let author = def.role === "editor" ? editor ?? photographer : def.role === "manager" ? manager : photographer;
    const parentEntry = def.reply ? [...plan.comments].reverse().find((c) => c !== null) ?? null : null;
    if (parentEntry && parentEntry.authorId === author) author = author === photographer ? editor ?? manager : photographer;
    const pool = author === manager ? MANAGER_COMMENTS : author === editor ? EDITOR_COMMENTS : PHOTOGRAPHER_COMMENTS;
    let body = parentEntry ? rng.pick(REPLY_COMMENTS) : rng.pick(pool);
    const mentionUserIds: string[] = [];
    if (def.mention) {
      const target = author === photographer ? editor ?? manager : author === editor ? photographer : editor ?? photographer;
      if (target && target !== author && (await rt.isActive(target))) {
        const name = await this.userName(target);
        body = `@${name} ${body}`;
        mentionUserIds.push(target);
      }
    }
    const result = await rt.act(author, (tx, ctx) =>
      addComment(tx, ctx, { jobId, body, kind: def.reply ? "comment" : rng.chance(0.15) ? "question" : "comment", parentCommentId: parentEntry?.id, mentionUserIds }),
    );
    plan.comments[def.idx] = { id: result.comment.id, authorId: author };
  }

  private readonly names = new Map<string, string>();

  private async userName(userId: string): Promise<string> {
    let name = this.names.get(userId);
    if (!name) {
      name = (await first(this.rt.db.select({ name: users.name }).from(users).where(eq(users.id, userId))))?.name ?? "team";
      this.names.set(userId, name);
    }
    return name;
  }
}
