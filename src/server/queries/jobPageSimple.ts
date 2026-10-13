/**
 * The single-scroll job page (docs/SIMPLIFICATION-PLAN.md §5), built on top
 * of `getJobDetail` (same 404 rule, same per-persona redaction and editor
 * read cut-off) and the stage layer in `src/lib/stages.ts`:
 *
 *   header        stage pill · "Waiting on: Sam" · due chip · Round N · Rush · Shot by / Edited by
 *   nextStep      one sentence, at most two buttons (per stage × viewer), with
 *                 the editor picker rows when assigning, the self-review
 *                 confirm flag (owners only, §12.3) and the "share with the
 *                 client?" flag when the client uses the portal (§12.2)
 *   files         Raw files · Finished photos (+ earlier versions) · Other links
 *   instructions  description + photographer / editor notes merged
 *   changesAsked  one row per round: what, who, when, Fixed / Open
 *   messages      the staff thread (every comment kind but client feedback)
 *   privateNotes  internal + client notes — owners / photographers only
 *   fromClient    client feedback threads — staff only, portal clients only, once the job is shared
 *   deliveryNotes what the client was told with the finished work — staff only
 *   whoDidWhat    short dated list from the ledgers (transitions, assignments,
 *                 revisions): the same facts HISTORY_EVENT_TYPES mirror in the
 *                 audit log, which stays reachable through "Full history"
 *   sideColumn    Shoot · Due · Client delivery (portal only) · Type · Rush · Client can see
 */
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { clients } from "@/db/schema";
import { LINK_KIND_META } from "@/lib/constants";
import { describeStage, nextStepFor, waitingOnLabel, type NextStep } from "@/lib/stages";
import type {
  AuthContext,
  ChangesAskedRound,
  InstructionItem,
  JobDetail,
  JobPermissionRef,
  LinkView,
  SimpleFiles,
  SimpleJobPage,
  SimpleJobPermissions,
  SimpleLink,
  SimpleNextStep,
  SimpleViewerRole,
  UserRef,
  WhoDidWhatEntry,
} from "@/lib/types";
import { can, isAdmin, isAssignedJob, managesJob, workedOnJob } from "@/server/auth/permissions";
import { loadJobRef } from "@/server/auth/job-ref";
import { editorPickerOptions } from "./editors";
import { getJobDetail } from "./jobDetail";
import { simpleBounds, simpleDue } from "./jobsSimple";
import { assertStaffRead } from "./scope";

/* ------------------------------------------------------------------ */
/*  Viewer                                                             */
/* ------------------------------------------------------------------ */

/** reviewer = owner / co-owner, or the photographer managing the job; editor = the job's current editor. */
export function viewerRoleFor(ctx: AuthContext, ref: JobPermissionRef): SimpleViewerRole {
  if (isAdmin(ctx)) return "reviewer";
  if (ctx.role === "photographer" && managesJob(ctx, ref)) return "reviewer";
  if (isAssignedJob(ctx, ref)) return "editor";
  return "other";
}

/** The server-side permission behind each next step. */
function stepAllowed(ctx: AuthContext, step: NextStep, ref: JobPermissionRef, admin: boolean): boolean {
  switch (step) {
    case "assign_editor":
    case "change_editor":
      return can(ctx, "job.assign_editor", ref);
    case "start_editing":
      return can(ctx, "job.start", ref);
    case "send_for_checking":
      return can(ctx, "job.submit", ref);
    case "check":
      // Owners / co-owners may approve a job they edited themselves after the confirm (§12.3).
      return admin || can(ctx, "job.approve", ref);
    case "restore":
      return can(ctx, "job.restore", ref);
    case "none":
      return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Files / instructions / rounds                                      */
/* ------------------------------------------------------------------ */

const toSimpleLink = (l: LinkView): SimpleLink => ({ id: l.id, kind: l.kind, url: l.url, label: l.label, addedAt: l.createdAt });

/** Three slots: raw files, finished photos (latest + earlier versions), other current links. */
export function buildFiles(detail: JobDetail): SimpleFiles {
  const current = detail.links.flatMap((s) => (s.current ? [s.current] : []));
  const raw = current.filter((l) => l.kind === "raw_files").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const finishedAll = detail.links
    .filter((s) => LINK_KIND_META[s.kind].finishedWork)
    .flatMap((s) => s.history)
    .filter((l) => l.removedAt === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const finished = finishedAll.find((l) => l.isCurrent) ?? null;
  const earlierVersions = finishedAll.filter((l) => l !== finished);
  const other = current.filter((l) => l.kind !== "raw_files" && !LINK_KIND_META[l.kind].finishedWork);
  return { raw, finished, earlierVersions, other };
}

/**
 * Description + photographer / editor notes (and revision notes) as one list, oldest first.
 * Private notes (internal / client) live in their own tinted box; delivery notes are what the CLIENT
 * was told with the finished work, so they never read as a brief to the editor (`deliveryNotes`).
 */
export function buildInstructions(detail: JobDetail): InstructionItem[] {
  const out: InstructionItem[] = [];
  const description = detail.job.description?.trim();
  if (description) out.push({ source: "description", body: description, author: null, at: detail.job.createdAt, noteId: null });
  for (const n of detail.notes) {
    if (n.archivedAt !== null) continue;
    if (n.kind === "internal" || n.kind === "client" || n.kind === "delivery") continue;
    out.push({ source: n.kind, body: n.body, author: n.author, at: n.createdAt, noteId: n.id });
  }
  // The description always leads; notes follow oldest first.
  const head = out.filter((i) => i.source === "description");
  const notes = out.filter((i) => i.source !== "description").sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return [...head, ...notes];
}

export function buildChangesAsked(detail: JobDetail): ChangesAskedRound[] {
  return detail.revisions.map((r) => ({
    id: r.id,
    round: r.revisionNumber,
    what: r.description,
    reason: r.reason,
    who: r.requestedBy,
    when: r.requestedAt,
    status: r.isOpen ? "open" : r.resolution === "withdrawn" ? "withdrawn" : "fixed",
    fixedAt: r.resolvedAt,
  }));
}

/* ------------------------------------------------------------------ */
/*  Who did what                                                       */
/* ------------------------------------------------------------------ */

/**
 * The short dated list from the ledgers: created, given to, (moved to),
 * started, sent for checking (on time?), changes asked, sent back, approved,
 * sent to client, closed, cancelled, restored, reopened.
 */
export function buildWhoDidWhat(detail: JobDetail, timeZone: string): WhoDidWhatEntry[] {
  const out: WhoDidWhatEntry[] = [];
  const due = detail.job.dueDateAtApproval ?? detail.job.dueDate;
  const onTimeAt = (at: string): boolean | null => {
    if (!due) return null;
    const dueDay = civilOf(new Date(Date.parse(due) - 1), timeZone);
    const sentDay = civilOf(new Date(at), timeZone);
    return dueDay !== null && sentDay !== null ? sentDay <= dueDay : null;
  };
  let seenSubmit = false;
  let seenStart = false;
  for (const st of detail.stages) {
    if (st.kind === "creation") {
      out.push(entry(st.enteredAt, "created", st.actor));
      continue;
    }
    if (st.kind === "reattribution") {
      out.push({ ...entry(st.enteredAt, "moved_to", st.actor), subject: st.editorAtEntry });
      continue;
    }
    if (st.isReopen) {
      out.push(entry(st.enteredAt, "reopened", st.actor));
      continue;
    }
    switch (st.toCategory) {
      case "in_progress":
        if (!seenStart) out.push(entry(st.enteredAt, "started", st.actor ?? st.editorAtEntry));
        seenStart = true;
        break;
      case "submitted":
      case "resubmitted":
        if (!seenSubmit) out.push({ ...entry(st.enteredAt, "sent_for_checking", st.actor ?? st.editorAtEntry), onTime: onTimeAt(st.enteredAt) });
        else out.push(entry(st.enteredAt, "sent_back", st.actor ?? st.editorAtEntry));
        seenSubmit = true;
        break;
      case "approved":
        out.push(entry(st.enteredAt, "approved", st.actor));
        break;
      case "delivered":
        out.push(entry(st.enteredAt, "sent_to_client", st.actor));
        break;
      case "completed":
        out.push(entry(st.enteredAt, "closed", st.actor));
        break;
      case "cancelled":
        out.push(entry(st.enteredAt, "cancelled", st.actor));
        break;
      default:
        if (st.fromCategory === "cancelled") out.push(entry(st.enteredAt, "restored", st.actor));
        break;
    }
  }
  for (const a of detail.assignments) {
    if (a.role !== "editor") continue;
    out.push({ ...entry(a.assignedAt, "given_to", a.assignedBy), subject: a.user });
    if (a.unassignedAt !== null && a.unassignReason !== "reassigned" && a.unassignReason !== "cancelled") {
      out.push({ ...entry(a.unassignedAt, "taken_back", a.unassignedBy), subject: a.user });
    }
  }
  for (const r of detail.revisions) out.push({ ...entry(r.requestedAt, "changes_asked", r.requestedBy), round: r.revisionNumber });
  const ORDER: Record<WhoDidWhatEntry["kind"], number> = {
    created: 0,
    taken_back: 1,
    given_to: 2,
    moved_to: 3,
    started: 4,
    sent_for_checking: 5,
    sent_back: 5,
    changes_asked: 6,
    approved: 7,
    sent_to_client: 8,
    closed: 9,
    cancelled: 10,
    restored: 10,
    reopened: 10,
  };
  return out.sort((a, b) => a.at.localeCompare(b.at) || ORDER[a.kind] - ORDER[b.kind]);
}

function entry(at: string, kind: WhoDidWhatEntry["kind"], actor: UserRef | null): WhoDidWhatEntry {
  return { at, kind, actor, subject: null, onTime: null, round: null };
}

function civilOf(d: Date, timeZone: string): string | null {
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/* ------------------------------------------------------------------ */
/*  getJobPageSimple                                                   */
/* ------------------------------------------------------------------ */

/** The whole simplified job page for a visible job (404 for missing / foreign / not-visible ids). */
export async function getJobPageSimple(db: DbLike, ctx: AuthContext, jobId: string): Promise<SimpleJobPage> {
  assertStaffRead(ctx);
  const detail = await getJobDetail(db, ctx, jobId);
  const { ref } = await loadJobRef(db, ctx, jobId);
  const now = ctx.now();
  const tz = ctx.settings.timezone;
  const bounds = await simpleBounds(db, ctx, now);
  const job = detail.job;
  const admin = isAdmin(ctx);
  const stage = describeStage({ category: job.statusCategory, revisionCount: job.revisionCount, startedAt: job.startedAt, statusEnteredAt: job.statusEnteredAt });
  const viewer = viewerRoleFor(ctx, ref);
  const kind = nextStepFor(stage.stage, viewer, job.statusCategory);
  const client = (await db.select({ portalEnabled: clients.portalEnabled }).from(clients).where(eq(clients.id, job.client.id)))[0];
  const clientHasPortal = client?.portalEnabled === true;
  const files = buildFiles(detail);
  const edited = workedOnJob(ctx, ref);

  const nextStep: SimpleNextStep = {
    kind,
    viewer,
    allowed: stepAllowed(ctx, kind, ref, admin),
    editorOptions: (kind === "assign_editor" || kind === "change_editor") && can(ctx, "job.assign_editor", ref) ? await editorPickerOptions(db, ctx) : null,
    selfReviewNeedsConfirm: kind === "check" && admin && edited,
    shareQuestion: kind === "check" && clientHasPortal,
    sentAt: stage.stage === "ready_to_check" ? (job.lastSubmittedAt ?? job.statusEnteredAt) : null,
    hasFinishedLink: files.finished !== null,
    lastFinishedLink: files.finished ? toSimpleLink(files.finished) : (files.earlierVersions[0] ? toSimpleLink(files.earlierVersions[0]) : null),
  };

  const isEditorViewer = ctx.role === "editor";
  const clientCanSee = job.sharedWithClient === true || job.projectSharedWithClient === true;
  // Plan §5 ⋯ menu: Change editor / Take back / Cancel belong to ACTIVE stages; Done jobs get Reopen, Cancelled get Restore.
  const permissions: SimpleJobPermissions = {
    canEditDetails: can(ctx, "job.edit_fields", ref),
    canChangeEditor: can(ctx, "job.assign_editor", ref) && job.editor !== null && stage.active,
    canTakeBack: can(ctx, "job.assign_editor", ref) && job.editor !== null && stage.active,
    canCancel: can(ctx, "job.cancel", ref) && stage.active,
    canRestore: can(ctx, "job.restore", ref) && stage.stage === "cancelled",
    canReopen: stage.stage === "done" && (admin || can(ctx, "job.reopen", ref)),
    canDecline: can(ctx, "job.decline", ref),
    canComment: can(ctx, "comment.add", ref),
    canAddPrivateNote: can(ctx, "note.add", { job: ref, kind: "internal" }) || can(ctx, "note.add", { job: ref, kind: "client" }),
    canReplyToClient: clientHasPortal && can(ctx, "client_feedback.reply", ref),
    canShareWithClient: clientHasPortal && !isEditorViewer && can(ctx, "job.share_with_client", ref),
  };
  const clientThreads = detail.comments.filter((c) => c.kind === "client_feedback");

  return {
    header: {
      id: job.id,
      jobNumber: job.jobNumber,
      name: job.name,
      client: job.client,
      jobTypeName: job.jobType.name,
      stage,
      waitingOn: waitingOnLabel({ category: job.statusCategory, photographer: job.photographer, editor: job.editor }, ctx.userId),
      due: simpleDue(job.dueDate, job.statusCategory, bounds, tz),
      round: stage.round,
      rush: job.priority === "urgent",
      shotBy: job.photographer,
      editedBy: job.editor,
      version: job.version,
    },
    nextStep,
    files,
    instructions: buildInstructions(detail),
    changesAsked: buildChangesAsked(detail),
    messages: detail.comments.filter((c) => c.kind !== "client_feedback"),
    privateNotes: isEditorViewer ? null : detail.notes.filter((n) => (n.kind === "internal" || n.kind === "client") && n.archivedAt === null),
    // "From the client" only once the client can actually see the job (or has already written).
    fromClient: isEditorViewer || !clientHasPortal || (!clientCanSee && clientThreads.length === 0) ? null : clientThreads,
    deliveryNotes: isEditorViewer ? null : detail.notes.filter((n) => n.kind === "delivery" && n.archivedAt === null),
    whoDidWhat: buildWhoDidWhat(detail, tz),
    sideColumn: {
      shootDate: job.shootDate,
      dueDate: job.dueDate,
      clientDeliveryDate: clientHasPortal ? job.deliveryDueDate : null,
      jobType: job.jobType,
      rush: job.priority === "urgent",
      clientHasPortal,
      clientCanSee,
    },
    permissions,
    description: job.description,
    asOf: now,
  };
}

