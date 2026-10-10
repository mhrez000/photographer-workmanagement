import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_STATUSES,
  DEFAULT_WORKFLOW_TRANSITIONS,
  EDITOR_LINK_KINDS,
  STATUS_CATEGORIES,
  type StatusCategory,
  type TransitionRole,
} from "@/lib/constants";
import type { AuthContext, ContextSettings } from "@/lib/types";
import { AmbiguousTargetError, NotFoundError } from "@/server/errors";
import {
  actorMayTakeEdge,
  allowedKanbanColumns,
  allowedTransitions,
  availableActions,
  categoryOf,
  findEdge,
  generateCancelEdges,
  isActiveCategory,
  isDeadlineBound,
  isDone,
  isEditorHolds,
  isLateral,
  isReviewerHolds,
  isTerminal,
  kanbanColumnOf,
  kpiBucketOf,
  resolveKanbanDrop,
  resolveTargetStatus,
  validateWorkflowDefinition,
  type EdgeLike,
  type StatusLike,
  type WorkflowJobLike,
} from "./workflow";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ORG = "org-1";
const OWNER = "u-owner";
const CO_ADMIN = "u-coadmin";
const PHOTOG = "u-photog";
const EDITOR = "u-editor";

/**
 * Roles v2 actors (docs/ROLES.md §12.1 porting rule): v1 "owner" → the admin
 * owner, v1 "manager" (a second management user acting on any job) → a co-admin,
 * "photographer" → a team member with the migrated switches (create, assign,
 * review) on their own jobs, "editor" → the assigned editor.
 */
type Actor = "owner" | "coAdmin" | "photographer" | "editor";
const ACTOR_ID: Record<Actor, string> = { owner: OWNER, coAdmin: CO_ADMIN, photographer: PHOTOG, editor: EDITOR };

const SETTINGS: ContextSettings = {
  timezone: "Australia/Sydney",
  timeTrackingEnabled: true,
  automationsEnabled: true,
};

function ctx(actor: Actor, over: Partial<AuthContext> = {}): AuthContext {
  const admin = actor === "owner" || actor === "coAdmin";
  const member = actor === "photographer";
  return {
    userId: ACTOR_ID[actor],
    organisationId: ORG,
    role: actor === "editor" ? "editor" : "photographer",
    isAdmin: admin,
    isPrimaryOwner: actor === "owner",
    isActive: true,
    canCreateJobs: true,
    canViewAllJobs: admin,
    canAssignEditors: admin || member,
    canReviewSubmissions: admin || member,
    canViewTeamWorkloads: admin,
    canViewAnalytics: admin,
    canViewTeamJobs: false,
    clientId: null,
    clientFeedbackEnabled: false,
    teamUserIds: new Set(),
    settings: SETTINGS,
    isSystem: false,
    now: () => "2026-10-09T03:00:00.000Z",
    requestId: "req",
    ...over,
  };
}

const sid = (key: string) => `s-${key}`;

const DEFAULT_STATUSES: StatusLike[] = DEFAULT_WORKFLOW_STATUSES.map((s) => ({
  id: sid(s.key),
  key: s.key,
  name: s.name,
  category: s.category,
  sortOrder: s.sortOrder,
  isInitial: s.isInitial,
  archivedAt: null,
  colour: s.colour,
}));

const DEFAULT_EDGES: EdgeLike[] = [
  ...DEFAULT_WORKFLOW_TRANSITIONS.map((t, i) => ({
    id: `e-${i}`,
    fromStatusId: sid(t.from),
    toStatusId: sid(t.to),
    allowedRoles: t.allowedRoles,
    requiresAssignedEditor: t.requiresAssignedEditor ?? false,
    assigneeOnly: t.assigneeOnly ?? false,
    isReopen: t.isReopen ?? false,
    archivedAt: null,
    label: t.label,
  })),
  ...generateCancelEdges(DEFAULT_STATUSES),
];

const st = (key: string, category: StatusCategory, sortOrder: number, isInitial = false): StatusLike => ({
  id: sid(key),
  key,
  name: key.replace(/_/g, " "),
  category,
  sortOrder,
  isInitial,
  archivedAt: null,
});

const edge = (from: string, to: string, roles: TransitionRole[], flags: Partial<EdgeLike> = {}): EdgeLike => ({
  id: `e-${from}-${to}`,
  fromStatusId: sid(from),
  toStatusId: sid(to),
  allowedRoles: roles,
  requiresAssignedEditor: false,
  assigneeOnly: false,
  isReopen: false,
  archivedAt: null,
  ...flags,
});

/** roles v2 (§5.1): reviewer-side edges → ["photographer"]; editor-side → ["admin", "editor"]. */
const OMP: TransitionRole[] = ["photographer"];
const OME: TransitionRole[] = ["admin", "editor"];

/** "Video" workflow: two in_progress stages (Rough Cut / Final Cut) and a renamed review. */
const VIDEO_STATUSES: StatusLike[] = [
  st("new", "new", 0, true),
  st("assigned", "assigned", 1),
  st("rough_cut", "in_progress", 2),
  st("final_cut", "in_progress", 3),
  st("submitted", "submitted", 4),
  { ...st("client_review", "review", 5), name: "Client Review" },
  st("revision", "revision", 6),
  st("resubmitted", "resubmitted", 7),
  st("approved", "approved", 8),
  st("completed", "completed", 9),
  st("cancelled", "cancelled", 10),
];
const VIDEO_EDGES: EdgeLike[] = [
  edge("new", "assigned", OMP, { requiresAssignedEditor: true }),
  edge("assigned", "rough_cut", OME, { assigneeOnly: true }),
  edge("assigned", "final_cut", OME, { assigneeOnly: true }),
  edge("rough_cut", "final_cut", OME, { assigneeOnly: true }),
  edge("final_cut", "submitted", OME, { assigneeOnly: true }),
  edge("submitted", "client_review", OMP),
  edge("client_review", "revision", OMP),
  edge("client_review", "approved", OMP),
  edge("revision", "resubmitted", OME, { assigneeOnly: true }),
  edge("resubmitted", "approved", OMP),
  edge("approved", "completed", OMP),
  ...generateCancelEdges(VIDEO_STATUSES),
];

function jobAt(key: string, statuses: StatusLike[] = DEFAULT_STATUSES, over: Partial<WorkflowJobLike> = {}): WorkflowJobLike {
  const status = statuses.find((s) => s.key === key);
  if (!status) throw new Error(`no status ${key}`);
  const unassigned = status.category === "new" || status.category === "ready";
  return {
    id: "job-1",
    organisationId: ORG,
    photographerId: PHOTOG,
    editorId: unassigned ? null : EDITOR,
    createdByUserId: PHOTOG,
    createdByRole: "photographer",
    statusCategory: status.category,
    isPaused: false,
    pastEditorIds: unassigned ? [] : [EDITOR],
    draftClosed: true,
    clientId: "client-1",
    sharedWithClient: false,
    projectSharedWithClient: false,
    statusId: status.id,
    previousStatusId: null,
    ...over,
  };
}

const targets = (role: Actor, job: WorkflowJobLike, statuses = DEFAULT_STATUSES, edges = DEFAULT_EDGES) =>
  allowedTransitions(ctx(role), job, statuses, edges).map((t) => t.toStatus.key);

/* ------------------------------------------------------------------ */
/*  Groups & lookups                                                   */
/* ------------------------------------------------------------------ */

describe("category helpers", () => {
  it("group predicates follow CATEGORY_GROUPS", () => {
    expect(STATUS_CATEGORIES.filter(isActiveCategory)).toHaveLength(11);
    expect(STATUS_CATEGORIES.filter(isTerminal)).toEqual(["completed", "cancelled"]);
    expect(STATUS_CATEGORIES.filter(isDone)).toEqual(["approved", "delivered", "completed"]);
    expect(STATUS_CATEGORIES.filter(isDeadlineBound)).toEqual(["new", "ready", "assigned", "accepted", "in_progress", "submitted", "review", "revision", "resubmitted"]);
    expect(STATUS_CATEGORIES.filter(isEditorHolds)).toEqual(["assigned", "accepted", "in_progress", "revision"]);
    expect(STATUS_CATEGORIES.filter(isReviewerHolds)).toEqual(["submitted", "review", "resubmitted"]);
  });

  it("kpi bucket and kanban column", () => {
    expect(kpiBucketOf("ready")).toBe("unassigned");
    expect(kpiBucketOf("resubmitted")).toBe("awaiting_review");
    expect(kpiBucketOf("cancelled")).toBe("none");
    expect(kanbanColumnOf("delivered")).toBe("approved");
    expect(kanbanColumnOf("cancelled")).toBeNull();
  });

  it("categoryOf / findEdge / isLateral", () => {
    expect(categoryOf(DEFAULT_STATUSES, sid("review"))).toBe("review");
    expect(categoryOf(DEFAULT_STATUSES, "nope")).toBeNull();
    expect(findEdge(DEFAULT_EDGES, sid("in_progress"), sid("submitted"))?.assigneeOnly).toBe(true);
    expect(findEdge(DEFAULT_EDGES, sid("new"), sid("completed"))).toBeUndefined();
    const archived = [{ ...edge("new", "ready", OMP), archivedAt: "2026-01-01T00:00:00Z" }];
    expect(findEdge(archived, sid("new"), sid("ready"))).toBeUndefined();
    const [rough, fin] = [VIDEO_STATUSES[2], VIDEO_STATUSES[3]];
    expect(isLateral(rough, fin)).toBe(true);
    expect(isLateral(rough, rough)).toBe(false);
    expect(isLateral(rough, VIDEO_STATUSES[4])).toBe(false);
  });
});

describe("resolveTargetStatus", () => {
  it("by id", () => {
    expect(resolveTargetStatus(DEFAULT_STATUSES, { toStatusId: sid("approved") }).key).toBe("approved");
  });
  it("foreign / unknown / archived id → NotFoundError", () => {
    expect(() => resolveTargetStatus(DEFAULT_STATUSES, { toStatusId: "s-other-workflow" })).toThrow(NotFoundError);
    const archived = DEFAULT_STATUSES.map((s) => (s.key === "review" ? { ...s, archivedAt: "2026-01-01T00:00:00Z" } : s));
    expect(() => resolveTargetStatus(archived, { toStatusId: sid("review") })).toThrow(NotFoundError);
    expect(() => resolveTargetStatus(DEFAULT_STATUSES, {})).toThrow(NotFoundError);
  });
  it("by category → lowest sortOrder", () => {
    expect(resolveTargetStatus(DEFAULT_STATUSES, { toCategory: "submitted" }).key).toBe("submitted");
    expect(resolveTargetStatus(VIDEO_STATUSES, { toCategory: "in_progress" }).key).toBe("rough_cut");
  });
  it("category with no status → NotFoundError", () => {
    expect(() => resolveTargetStatus(VIDEO_STATUSES, { toCategory: "delivered" })).toThrow(NotFoundError);
  });
  it("ambiguity: strict mode with several, or a tie at the lowest sortOrder", () => {
    expect(() => resolveTargetStatus(VIDEO_STATUSES, { toCategory: "in_progress" }, "strict")).toThrow(AmbiguousTargetError);
    const tied = VIDEO_STATUSES.map((s) => (s.key === "final_cut" ? { ...s, sortOrder: 2 } : s));
    try {
      resolveTargetStatus(tied, { toCategory: "in_progress" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousTargetError);
      expect((e as AmbiguousTargetError).candidates.map((c) => c.key).sort()).toEqual(["final_cut", "rough_cut"]);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Allowed transitions                                                */
/* ------------------------------------------------------------------ */

const EXPECTED: Record<string, Record<"om" | "photographer" | "editor", string[]>> = {
  new: { om: ["ready", "cancelled"], photographer: ["ready", "cancelled"], editor: [] },
  ready: { om: ["new", "cancelled"], photographer: ["new", "cancelled"], editor: [] },
  // roles v2 §5.2: → ready while an editor holds the job is an unassignment (job.assign_editor), offered to
  // admins and to members with "Assign editors" on jobs they manage.
  assigned: { om: ["ready", "accepted", "in_progress", "cancelled"], photographer: ["ready", "cancelled"], editor: ["ready", "accepted", "in_progress"] },
  accepted: { om: ["ready", "in_progress", "cancelled"], photographer: ["ready", "cancelled"], editor: ["in_progress"] },
  in_progress: { om: ["ready", "submitted", "cancelled"], photographer: ["ready", "cancelled"], editor: ["submitted"] },
  submitted: { om: ["review", "revision", "approved", "cancelled"], photographer: ["review", "revision", "approved", "cancelled"], editor: [] },
  review: { om: ["revision", "approved", "cancelled"], photographer: ["revision", "approved", "cancelled"], editor: [] },
  revision: { om: ["ready", "resubmitted", "cancelled"], photographer: ["ready", "cancelled"], editor: ["resubmitted"] },
  resubmitted: { om: ["review", "revision", "approved", "cancelled"], photographer: ["review", "revision", "approved", "cancelled"], editor: [] },
  approved: { om: ["revision", "delivered", "completed", "cancelled"], photographer: ["revision", "delivered", "completed", "cancelled"], editor: [] },
  delivered: { om: ["revision", "completed", "cancelled"], photographer: ["revision", "completed", "cancelled"], editor: [] },
  completed: { om: ["in_progress", "revision", "approved"], photographer: ["in_progress", "revision", "approved"], editor: [] },
  cancelled: { om: ["in_progress"], photographer: ["in_progress"], editor: [] },
};

describe("allowedTransitions on the default workflow", () => {
  const cases = Object.keys(EXPECTED).flatMap((key) => (["owner", "coAdmin", "photographer", "editor"] as Actor[]).map((role) => [key, role] as const));
  it.each(cases)("%s as %s", (key, role) => {
    const job = jobAt(key, DEFAULT_STATUSES, key === "cancelled" ? { previousStatusId: sid("in_progress") } : {});
    const bucket = role === "owner" || role === "coAdmin" ? "om" : role;
    expect(targets(role, job)).toEqual(EXPECTED[key][bucket]);
  });

  it("labels and flags", () => {
    const byKey = (role: Actor, key: string, to: string) => allowedTransitions(ctx(role), jobAt(key), DEFAULT_STATUSES, DEFAULT_EDGES).find((t) => t.toStatus.key === to);
    expect(byKey("editor", "assigned", "ready")?.label).toBe("Decline");
    expect(byKey("editor", "assigned", "in_progress")?.label).toBe("Start");
    expect(byKey("editor", "in_progress", "submitted")?.label).toBe("Submit for review");
    expect(byKey("owner", "review", "revision")).toMatchObject({ label: "Request revision", requiresRevisionPayload: true, requiresReason: false });
    expect(byKey("owner", "review", "approved")?.label).toBe("Approve");
    expect(byKey("owner", "approved", "delivered")?.label).toBe("Deliver");
    expect(byKey("owner", "delivered", "completed")?.label).toBe("Complete");
    expect(byKey("owner", "in_progress", "cancelled")).toMatchObject({ label: "Cancel", requiresReason: true });
    expect(byKey("owner", "completed", "revision")).toMatchObject({ isReopen: true, requiresReason: true, requiresRevisionPayload: true });
    expect(byKey("owner", "completed", "approved")).toMatchObject({ isReopen: true, label: "Reopen (fix delivery)" });
    const restore = allowedTransitions(ctx("owner"), jobAt("cancelled", DEFAULT_STATUSES, { previousStatusId: sid("review") }), DEFAULT_STATUSES, DEFAULT_EDGES);
    expect(restore).toEqual([expect.objectContaining({ label: "Restore", isReopen: false, requiresReason: false })]);
    expect(restore[0].toStatus.key).toBe("review");
  });

  it("restore falls back to the initial status when the previous one is archived or unknown", () => {
    const statuses = DEFAULT_STATUSES.map((s) => (s.key === "review" ? { ...s, archivedAt: "2026-01-01T00:00:00Z" } : s));
    expect(targets("owner", jobAt("cancelled", statuses, { previousStatusId: sid("review") }), statuses)).toEqual(["new"]);
    expect(targets("owner", jobAt("cancelled", DEFAULT_STATUSES, { previousStatusId: null }))).toEqual(["new"]);
  });

  it("members without Assign editors / Review submissions get no unassign or review moves (§5.2 from-gate)", () => {
    const noFlags = ctx("photographer", { canAssignEditors: false, canReviewSubmissions: false });
    const moves = (key: string) => allowedTransitions(noFlags, jobAt(key), DEFAULT_STATUSES, DEFAULT_EDGES).map((t) => t.toStatus.key);
    expect(moves("in_progress")).toEqual(["cancelled"]);
    expect(moves("submitted")).toEqual([]);
    expect(moves("approved")).toEqual([]);
  });

  it("other photographers / unassigned editors get nothing", () => {
    expect(targets("photographer", jobAt("submitted", DEFAULT_STATUSES, { photographerId: "u-x", createdByUserId: "u-x" }))).toEqual([]);
    expect(targets("editor", jobAt("in_progress", DEFAULT_STATUSES, { editorId: "u-x" }))).toEqual([]);
  });

  it("requiresAssignedEditor edges need an ACTIVE editor", () => {
    const noEditor = jobAt("completed", DEFAULT_STATUSES, { editorId: null });
    expect(targets("owner", noEditor)).toEqual(["approved"]);
    const inactive = jobAt("approved", DEFAULT_STATUSES, { editorIsActive: false });
    expect(targets("owner", inactive)).toEqual(["delivered", "completed", "cancelled"]);
  });

  it("generated cancel edge is offered even when the workflow lacks an explicit one", () => {
    const edgesNoCancel = DEFAULT_EDGES.filter((e) => e.toStatusId !== sid("cancelled"));
    expect(targets("owner", jobAt("in_progress"), DEFAULT_STATUSES, edgesNoCancel)).toEqual(["ready", "submitted", "cancelled"]);
    expect(targets("photographer", jobAt("completed"), DEFAULT_STATUSES, edgesNoCancel)).not.toContain("cancelled");
  });

  it("Video workflow: duplicate labels are disambiguated and lateral moves allowed", () => {
    const t = allowedTransitions(ctx("editor"), jobAt("assigned", VIDEO_STATUSES), VIDEO_STATUSES, VIDEO_EDGES);
    expect(t.map((x) => x.label)).toEqual(["Start (rough cut)", "Start (final cut)"]);
    // final_cut → rough_cut has no edge but is lateral within in_progress
    const back = allowedTransitions(ctx("editor"), jobAt("final_cut", VIDEO_STATUSES), VIDEO_STATUSES, VIDEO_EDGES);
    expect(back.map((x) => x.toStatus.key)).toEqual(["rough_cut", "submitted"]);
    expect(back[0].label).toBe("Move to rough cut");
    // photographer may not enter in_progress, so no lateral move for them
    expect(targets("photographer", jobAt("final_cut", VIDEO_STATUSES), VIDEO_STATUSES, VIDEO_EDGES)).toEqual(["cancelled"]);
  });
});

describe("actorMayTakeEdge", () => {
  const submit = findEdge(DEFAULT_EDGES, sid("in_progress"), sid("submitted")) as EdgeLike;
  const approve = findEdge(DEFAULT_EDGES, sid("review"), sid("approved")) as EdgeLike;
  const unapprove = findEdge(DEFAULT_EDGES, sid("approved"), sid("revision")) as EdgeLike;

  it("role must be in allowedRoles", () => {
    expect(actorMayTakeEdge(ctx("editor"), jobAt("review"), approve)).toBe(false);
    expect(actorMayTakeEdge(ctx("photographer"), jobAt("in_progress"), submit)).toBe(false);
  });
  it("assigneeOnly → only the current editor (admins act on behalf)", () => {
    expect(actorMayTakeEdge(ctx("editor"), jobAt("in_progress"), submit)).toBe(true);
    expect(actorMayTakeEdge(ctx("editor"), jobAt("in_progress", DEFAULT_STATUSES, { editorId: "u-x" }), submit)).toBe(false);
    expect(actorMayTakeEdge(ctx("coAdmin"), jobAt("in_progress"), submit)).toBe(true);
  });
  it("photographer → own jobs only", () => {
    expect(actorMayTakeEdge(ctx("photographer"), jobAt("review"), approve)).toBe(true);
    expect(actorMayTakeEdge(ctx("photographer"), jobAt("review", DEFAULT_STATUSES, { photographerId: "u-x", createdByUserId: "u-x" }), approve)).toBe(false);
  });
  it("requiresAssignedEditor and system context", () => {
    expect(actorMayTakeEdge(ctx("owner"), jobAt("approved", DEFAULT_STATUSES, { editorId: null }), unapprove)).toBe(false);
    const sys = ctx("owner", { isSystem: true, userId: null });
    expect(actorMayTakeEdge(sys, jobAt("review"), approve)).toBe(true);
    expect(actorMayTakeEdge(sys, jobAt("approved", DEFAULT_STATUSES, { editorId: null }), unapprove)).toBe(false);
  });
  it("inactive actor and archived edge", () => {
    expect(actorMayTakeEdge(ctx("owner", { isActive: false }), jobAt("review"), approve)).toBe(false);
    expect(actorMayTakeEdge(ctx("owner"), jobAt("review"), { ...approve, archivedAt: "2026-01-01T00:00:00Z" })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Available actions                                                  */
/* ------------------------------------------------------------------ */

describe("availableActions", () => {
  const extras = { timeTrackingEnabled: true, openRevision: false, hasRunningSession: false };

  it("assigned editor mid-edit", () => {
    const a = availableActions(ctx("editor"), jobAt("in_progress"), DEFAULT_STATUSES, DEFAULT_EDGES, extras);
    expect(a.transitions.map((t) => t.toStatus.key)).toEqual(["submitted"]);
    expect(a).toMatchObject({
      canEditFields: false,
      canEditDeadlines: false,
      canSetPriority: false,
      canAssignEditor: false,
      canCancel: false,
      canRestore: false,
      canPause: true,
      canResume: false,
      canComment: true,
      canUseTimer: true,
      canRequestRevision: false,
      canWithdrawRevision: false,
    });
    expect(a.canAddLinkKinds).toEqual([...EDITOR_LINK_KINDS]);
    expect(a.canAddNoteKinds).toEqual(["editor", "revision"]);
  });

  it("paused job shows resume; timer off when tracking disabled", () => {
    const a = availableActions(ctx("editor"), jobAt("in_progress", DEFAULT_STATUSES, { isPaused: true }), DEFAULT_STATUSES, DEFAULT_EDGES, { ...extras, timeTrackingEnabled: false });
    expect(a.canPause).toBe(false);
    expect(a.canResume).toBe(true);
    expect(a.canUseTimer).toBe(false);
  });

  it("photographer reviewing own job", () => {
    const a = availableActions(ctx("photographer"), jobAt("submitted"), DEFAULT_STATUSES, DEFAULT_EDGES, { ...extras, openRevision: true });
    expect(a).toMatchObject({ canEditFields: true, canRequestRevision: true, canWithdrawRevision: true, canCancel: true, canPause: false, canAssignEditor: true });
    // roles v2: a member with Review submissions may also write client-visible delivery notes (§3.3)
    expect(a.canAddNoteKinds).toEqual(["photographer", "revision", "client", "delivery"]);
  });

  it("cancelled job: restore only", () => {
    const a = availableActions(ctx("coAdmin"), jobAt("cancelled", DEFAULT_STATUSES, { previousStatusId: sid("assigned") }), DEFAULT_STATUSES, DEFAULT_EDGES, extras);
    expect(a.canRestore).toBe(true);
    expect(a.canCancel).toBe(false);
    expect(a.canAssignEditor).toBe(false);
    expect(a.transitions.map((t) => t.toStatus.key)).toEqual(["assigned"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Kanban drop                                                        */
/* ------------------------------------------------------------------ */

describe("resolveKanbanDrop", () => {
  it("noop when the job already sits in the column", () => {
    expect(resolveKanbanDrop(ctx("editor"), jobAt("accepted"), "assigned", DEFAULT_STATUSES, DEFAULT_EDGES)).toEqual({ kind: "noop" });
    expect(resolveKanbanDrop(ctx("owner"), jobAt("resubmitted"), "review", DEFAULT_STATUSES, DEFAULT_EDGES)).toEqual({ kind: "noop" });
  });

  it("single candidate", () => {
    const r = resolveKanbanDrop(ctx("editor"), jobAt("in_progress"), "review", DEFAULT_STATUSES, DEFAULT_EDGES);
    expect(r.kind).toBe("single");
    if (r.kind === "single") {
      expect(r.toStatus.key).toBe("submitted");
      expect(r.edge?.fromStatusId).toBe(sid("in_progress"));
    }
    const approve = resolveKanbanDrop(ctx("owner"), jobAt("submitted"), "approved", DEFAULT_STATUSES, DEFAULT_EDGES);
    expect(approve.kind === "single" && approve.toStatus.key).toBe("approved");
    const restore = resolveKanbanDrop(ctx("owner"), jobAt("cancelled", DEFAULT_STATUSES, { previousStatusId: sid("review") }), "review", DEFAULT_STATUSES, DEFAULT_EDGES);
    expect(restore.kind === "single" && restore.edge).toBeNull();
  });

  it("ambiguous: Video workflow has two in_progress statuses", () => {
    const r = resolveKanbanDrop(ctx("editor"), jobAt("assigned", VIDEO_STATUSES), "in_progress", VIDEO_STATUSES, VIDEO_EDGES);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates.map((c) => c.toStatus.key)).toEqual(["rough_cut", "final_cut"]);
  });

  it("none, with an explanation", () => {
    const p = resolveKanbanDrop(ctx("photographer"), jobAt("in_progress"), "review", DEFAULT_STATUSES, DEFAULT_EDGES);
    expect(p).toEqual({ kind: "none", reason: "Your role cannot make this change" });
    const assign = resolveKanbanDrop(ctx("owner"), jobAt("new"), "assigned", DEFAULT_STATUSES, DEFAULT_EDGES);
    expect(assign).toEqual({ kind: "none", reason: "Assign an editor to move this job to Assigned" });
    const noEdge = resolveKanbanDrop(ctx("owner"), jobAt("new"), "completed", DEFAULT_STATUSES, DEFAULT_EDGES);
    expect(noEdge.kind).toBe("none");
    if (noEdge.kind === "none") expect(noEdge.reason).toContain("Cannot move");
    const statuses = VIDEO_STATUSES.filter((s) => s.category !== "revision");
    const edges = VIDEO_EDGES.filter((e) => e.toStatusId !== sid("revision") && e.fromStatusId !== sid("revision"));
    expect(resolveKanbanDrop(ctx("owner"), jobAt("client_review", statuses), "revision", statuses, edges)).toEqual({
      kind: "none",
      reason: "This workflow has no Revision status",
    });
  });

  it("allowedKanbanColumns", () => {
    expect(allowedKanbanColumns(ctx("owner"), jobAt("submitted"), DEFAULT_STATUSES, DEFAULT_EDGES)).toEqual(["revision", "approved"]);
    expect(allowedKanbanColumns(ctx("editor"), jobAt("assigned"), DEFAULT_STATUSES, DEFAULT_EDGES)).toEqual(["new", "in_progress"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Validation & cancel edges                                          */
/* ------------------------------------------------------------------ */

describe("validateWorkflowDefinition", () => {
  it("accepts the default and Video workflows", () => {
    expect(validateWorkflowDefinition(DEFAULT_STATUSES, DEFAULT_EDGES)).toEqual([]);
    expect(validateWorkflowDefinition(VIDEO_STATUSES, VIDEO_EDGES)).toEqual([]);
  });

  const mutate = (fn: (s: StatusLike[], e: EdgeLike[]) => [StatusLike[], EdgeLike[]]) => {
    const [s, e] = fn(
      DEFAULT_STATUSES.map((x) => ({ ...x })),
      DEFAULT_EDGES.map((x) => ({ ...x })),
    );
    return validateWorkflowDefinition(s, e);
  };

  it.each<[string, (s: StatusLike[], e: EdgeLike[]) => [StatusLike[], EdgeLike[]], RegExp]>([
    ["two initial statuses", (s, e) => [s.map((x) => (x.key === "ready" ? { ...x, isInitial: true } : x)), e], /Exactly one initial status/],
    ["no initial status", (s, e) => [s.map((x) => ({ ...x, isInitial: false })), e], /Exactly one initial status is required \(found 0\)/],
    ["initial not in category new", (s, e) => [s.map((x) => (x.key === "new" ? { ...x, isInitial: false } : x.key === "ready" ? { ...x, isInitial: true } : x)), e], /must be in category "new"/],
    ["missing required category", (s, e) => [s.filter((x) => x.key !== "submitted"), e.filter((y) => y.fromStatusId !== sid("submitted") && y.toStatusId !== sid("submitted"))], /required category "submitted"/],
    ["bad key", (s, e) => [s.map((x) => (x.key === "review" ? { ...x, key: "Review Required" } : x)), e], /lowercase slug/],
    ["duplicate key", (s, e) => [s.map((x) => (x.key === "review" ? { ...x, key: "submitted" } : x)), e], /key "submitted" is used 2 times/],
    ["duplicate name", (s, e) => [s.map((x) => (x.key === "review" ? { ...x, name: "Approved" } : x)), e], /name "Approved" is used more than once/],
    ["empty allowedRoles", (s, e) => [s, e.map((y, i) => (i === 0 ? { ...y, allowedRoles: [] } : y))], /at least one role/],
    ["unknown role", (s, e) => [s, e.map((y, i) => (i === 0 ? { ...y, allowedRoles: ["client" as TransitionRole] } : y))], /unknown role "client"/],
    ["duplicate edge", (s, e) => [s, [...e, { ...e[0], id: "dup" }]], /Duplicate transition/],
    ["self loop", (s, e) => [s, [...e, edge("review", "review", OMP)]], /itself/],
    ["dangling edge", (s, e) => [s, [...e, edge("review", "ghost", OMP)]], /missing or archived status/],
    ["dead-end status", (s, e) => [s, e.filter((y) => y.fromStatusId !== sid("in_progress") || y.toStatusId === sid("cancelled"))], /"In Progress" has no outgoing transition/],
    ["unreachable status", (s, e) => [[...s, st("orphan", "review", 20)], [...e, edge("orphan", "approved", OMP)]], /"orphan" is not reachable/],
  ])("flags %s", (_name, fn, pattern) => {
    const problems = mutate(fn);
    expect(problems.some((p) => pattern.test(p)), problems.join("\n")).toBe(true);
  });

  it("ignores archived statuses and edges", () => {
    const s = [...DEFAULT_STATUSES, { ...st("old", "review", 30), archivedAt: "2026-01-01T00:00:00Z" }];
    const e = [...DEFAULT_EDGES, { ...edge("old", "ghost", []), archivedAt: "2026-01-01T00:00:00Z" }];
    expect(validateWorkflowDefinition(s, e)).toEqual([]);
  });
});

describe("generateCancelEdges", () => {
  it("one photographer edge from every active, non-archived status to the cancelled status", () => {
    const edges = generateCancelEdges(DEFAULT_STATUSES);
    expect(edges).toHaveLength(11);
    expect(new Set(edges.map((e) => e.toStatusId))).toEqual(new Set([sid("cancelled")]));
    expect(edges.map((e) => e.fromStatusId)).not.toContain(sid("completed"));
    expect(edges.map((e) => e.fromStatusId)).not.toContain(sid("cancelled"));
    expect(edges.every((e) => e.allowedRoles.join() === "photographer" && !e.assigneeOnly && !e.isReopen)).toBe(true);
    const archived = DEFAULT_STATUSES.map((s) => (s.key === "review" ? { ...s, archivedAt: "2026-01-01T00:00:00Z" } : s));
    expect(generateCancelEdges(archived)).toHaveLength(10);
  });
  it("no cancelled status → no edges", () => {
    expect(generateCancelEdges(DEFAULT_STATUSES.filter((s) => s.category !== "cancelled"))).toEqual([]);
  });
});
