import type { StatusCategory } from "@/lib/constants";

/**
 * The five user-facing STAGES (docs/SIMPLIFICATION-PLAN.md §4).
 *
 * This is a pure display/translation layer over the 13 workflow status
 * categories. Nothing in the database is rewritten: every job keeps its exact
 * status, transitions and history; screens show the stage.
 *
 *   Needs editor   ← new, ready
 *   With editor    ← assigned, accepted ("Not started"), in_progress ("Editing since …")
 *   Ready to check ← submitted, review, resubmitted ("Round N" when revisionCount > 0)
 *   Changes asked  ← revision
 *   Done           ← approved ("Not sent to client" badge), delivered, completed
 *   Cancelled      ← cancelled (never a tab; only via the "Show cancelled" filter)
 */

export const STAGES = ["needs_editor", "with_editor", "ready_to_check", "changes_asked", "done", "cancelled"] as const;
export type Stage = (typeof STAGES)[number];

/** Stages shown as tabs on the Jobs page, in order. `cancelled` is a filter, not a tab. */
export const STAGE_TABS: readonly Stage[] = ["needs_editor", "with_editor", "ready_to_check", "changes_asked", "done"];

/** Who the job is waiting on in each stage. */
export type WaitingOn = "photographer" | "editor" | "nobody";

export interface StageMeta {
  label: string;
  /** Short explanation shown in help text and tooltips. */
  description: string;
  /** Design-token hue used by the stage pill (see globals.css). */
  tone: "grey" | "blue" | "amber" | "red" | "green" | "slate";
  waitingOn: WaitingOn;
  /** Counts as "active" work (Done and Cancelled never do). */
  active: boolean;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  needs_editor: { label: "Needs editor", description: "Shot, nobody is editing it yet", tone: "grey", waitingOn: "photographer", active: true },
  with_editor: { label: "With editor", description: "The editor has it", tone: "blue", waitingOn: "editor", active: true },
  ready_to_check: { label: "Ready to check", description: "The editor sent it back; your turn", tone: "amber", waitingOn: "photographer", active: true },
  changes_asked: { label: "Changes asked", description: "Back with the editor with your note", tone: "red", waitingOn: "editor", active: true },
  done: { label: "Done", description: "Finished", tone: "green", waitingOn: "nobody", active: false },
  cancelled: { label: "Cancelled", description: "Not going ahead", tone: "slate", waitingOn: "nobody", active: false },
};

const CATEGORY_TO_STAGE: Record<StatusCategory, Stage> = {
  new: "needs_editor",
  ready: "needs_editor",
  assigned: "with_editor",
  accepted: "with_editor",
  in_progress: "with_editor",
  submitted: "ready_to_check",
  review: "ready_to_check",
  resubmitted: "ready_to_check",
  revision: "changes_asked",
  approved: "done",
  delivered: "done",
  completed: "done",
  cancelled: "cancelled",
};

export function stageOf(category: StatusCategory): Stage {
  return CATEGORY_TO_STAGE[category];
}

/** All status categories that display as `stage` (for SQL filters). */
export function categoriesForStage(stage: Stage): StatusCategory[] {
  return (Object.keys(CATEGORY_TO_STAGE) as StatusCategory[]).filter((c) => CATEGORY_TO_STAGE[c] === stage);
}

/** Categories that count as active work in the simplified model (Done/Cancelled excluded). */
export const ACTIVE_STAGE_CATEGORIES: readonly StatusCategory[] = STAGES.filter((s) => STAGE_META[s].active).flatMap(categoriesForStage);

export interface StageDisplayInput {
  category: StatusCategory;
  /** jobs.revision_count */
  revisionCount: number;
  /** jobs.started_at (first time editing began) */
  startedAt?: string | null;
  /** jobs.status_entered_at — when the job entered its current status */
  statusEnteredAt?: string | null;
}

export interface StageDisplay {
  stage: Stage;
  label: string;
  /** Small secondary text: "Not started", "Editing since …" (caller formats the date), "Round 2", "Not sent to client". */
  subLabel: "not_started" | "editing" | "round" | "not_sent_to_client" | null;
  /** Round number for the "Round N" badge (1 = first resubmission). */
  round: number | null;
  waitingOn: WaitingOn;
  active: boolean;
}

/** Everything a stage pill needs, from plain job columns. */
export function describeStage(input: StageDisplayInput): StageDisplay {
  const stage = stageOf(input.category);
  const meta = STAGE_META[stage];
  let subLabel: StageDisplay["subLabel"] = null;
  let round: number | null = null;
  switch (input.category) {
    case "assigned":
    case "accepted":
      subLabel = "not_started";
      break;
    case "in_progress":
      subLabel = "editing";
      break;
    case "submitted":
    case "review":
    case "resubmitted":
      if (input.revisionCount > 0) {
        subLabel = "round";
        round = input.revisionCount + 1;
      }
      break;
    case "approved":
      subLabel = "not_sent_to_client";
      break;
    default:
      break;
  }
  return { stage, label: meta.label, subLabel, round, waitingOn: meta.waitingOn, active: meta.active };
}

/**
 * "Waiting on: <name>" for a job. Returns null for Done/Cancelled.
 * `viewerId` turns the viewer's own name into "You".
 */
export function waitingOnLabel(
  job: { category: StatusCategory; photographer: { id: string; name: string } | null; editor: { id: string; name: string } | null },
  viewerId?: string | null,
): string | null {
  const who = STAGE_META[stageOf(job.category)].waitingOn;
  if (who === "nobody") return null;
  const person = who === "editor" ? job.editor : job.photographer;
  if (!person) return who === "editor" ? "an editor" : "the photographer";
  return viewerId && person.id === viewerId ? "You" : person.name;
}

/** The next main action for a job, by stage and viewer role (SIMPLIFICATION-PLAN §5 "Next step" card). */
export type NextStep =
  | "assign_editor"
  | "change_editor"
  | "start_editing"
  | "send_for_checking"
  | "check" // Approve / Ask for changes
  | "restore"
  | "none";

export function nextStepFor(stage: Stage, viewer: "reviewer" | "editor" | "other", category: StatusCategory): NextStep {
  if (stage === "cancelled") return viewer === "reviewer" ? "restore" : "none";
  if (stage === "done") return "none";
  if (viewer === "reviewer") {
    if (stage === "needs_editor") return "assign_editor";
    if (stage === "ready_to_check") return "check";
    return "change_editor";
  }
  if (viewer === "editor") {
    if (stage === "with_editor") return category === "in_progress" ? "send_for_checking" : "start_editing";
    if (stage === "changes_asked") return "send_for_checking";
    return "none";
  }
  return "none";
}
