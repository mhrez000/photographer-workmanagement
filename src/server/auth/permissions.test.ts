/**
 * Roles v2 policy (docs/ROLES.md §3) — table-driven over every action ×
 * persona × resource situation, plus the structural rules (PERMISSIONS ↔
 * POLICY, flag-gated cells, hard rules, self-review, primary owner, matrix).
 * The SQL twins are checked against these rules on a real database in
 * visibleJobs.pg.test.ts.
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ACTIONS,
  EDITOR_FLAGS,
  LINK_KINDS,
  MEMBER_FLAGS,
  NOTE_KINDS,
  PERMISSIONS,
  PERSONAS,
  PHOTOGRAPHER_PRESET_META,
  PRIMARY_OWNER_PROTECTED_ACTIONS,
  SELF_APPROVAL_CONFIRM_ACTIONS,
  SELF_REVIEW_ACTIONS,
  personaMayEver,
  photographerPresetOf,
  type Action,
  type EditorFlag,
  type MemberFlag,
  type Persona,
  type StatusCategory,
} from "@/lib/constants";
import type { AuthContext, JobPermissionRef } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";
import {
  POLICY,
  SYSTEM_ACTION_ALLOWLIST,
  actionNeedsSelfApprovalConfirm,
  assertCan,
  can,
  canSeeManagementEvents,
  canViewJob,
  controlsJob,
  hardRuleDenial,
  inviteSwitchesFor,
  managesJob,
  permissionMatrix,
  personaOf,
  portalJobsWhere,
  ruleMeta,
  selfReviewBlocked,
  selfReviewNeedsConfirm,
  visibleJobsWhere,
  type ResourceOf,
} from "./permissions";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ORG = "org-1";
const ME = "u-me";
const OWNER = "u-owner";
const P2 = "u-p2";
const E2 = "u-e2";
const CLIENT = "c-1";
const NOW = "2026-10-09T03:00:00.000Z";

type ActorKey =
  | "admin"
  | "member"
  | "memberBare"
  | "memberAll"
  | "editor"
  | "editorTeam"
  | "editorNoCreate"
  | "client"
  | "clientNoFeedback";

const NO_FLAGS = {
  canCreateJobs: false,
  canViewAllJobs: false,
  canAssignEditors: false,
  canReviewSubmissions: false,
  canViewTeamWorkloads: false,
  canViewAnalytics: false,
  canViewTeamJobs: false,
};
const ALL_MEMBER = {
  canCreateJobs: true,
  canViewAllJobs: true,
  canAssignEditors: true,
  canReviewSubmissions: true,
  canViewTeamWorkloads: true,
  canViewAnalytics: true,
};

function base(over: Partial<AuthContext>): AuthContext {
  return {
    userId: ME,
    organisationId: ORG,
    role: "photographer",
    isAdmin: false,
    isPrimaryOwner: false,
    isActive: true,
    ...NO_FLAGS,
    clientId: null,
    clientFeedbackEnabled: false,
    teamUserIds: new Set<string>(),
    settings: { timezone: "Australia/Sydney", timeTrackingEnabled: true, automationsEnabled: true },
    isSystem: false,
    now: () => NOW,
    requestId: "req-test",
    ...over,
  };
}

/** Effective contexts per actor (the session builder's output shape). */
function actor(key: ActorKey, over: Partial<AuthContext> = {}): AuthContext {
  switch (key) {
    case "admin":
      return base({ isAdmin: true, ...ALL_MEMBER, ...over });
    case "member": // migrated defaults: create ✓ assign ✓ review ✓
      return base({ canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, ...over });
    case "memberBare":
      return base({ ...over });
    case "memberAll":
      return base({ ...ALL_MEMBER, ...over });
    case "editor":
      return base({ role: "editor", canCreateJobs: true, ...over });
    case "editorTeam":
      return base({ role: "editor", canCreateJobs: true, canViewTeamJobs: true, ...over });
    case "editorNoCreate":
      return base({ role: "editor", ...over });
    case "client":
      return base({ role: "client", clientId: CLIENT, clientFeedbackEnabled: true, ...over });
    case "clientNoFeedback":
      return base({ role: "client", clientId: CLIENT, ...over });
  }
}

const PHOTO_ACTORS = ["admin", "member", "memberBare", "memberAll"] as const;
const EDITOR_ACTORS = ["editor", "editorTeam", "editorNoCreate"] as const;
const ALL_ACTORS: readonly ActorKey[] = [...PHOTO_ACTORS, ...EDITOR_ACTORS, "client", "clientNoFeedback"];

function ref(over: Partial<JobPermissionRef> = {}): JobPermissionRef {
  return {
    id: "job-x",
    organisationId: ORG,
    photographerId: P2,
    editorId: E2,
    createdByUserId: P2,
    createdByRole: "photographer",
    statusCategory: "in_progress",
    isPaused: false,
    pastEditorIds: [E2],
    draftClosed: true,
    clientId: CLIENT,
    sharedWithClient: false,
    projectSharedWithClient: false,
    cancelledAt: null,
    ...over,
  };
}

/** Situations seen from a photographer persona (ME is a photographer). */
const PHOTO_SITS = {
  own: (c: StatusCategory) => ref({ statusCategory: c, photographerId: ME, createdByUserId: ME }),
  shotFor: (c: StatusCategory) => ref({ statusCategory: c, photographerId: ME, createdByUserId: OWNER }),
  creator: (c: StatusCategory) => ref({ statusCategory: c, createdByUserId: ME }),
  exEditorCreated: (c: StatusCategory) => ref({ statusCategory: c, createdByUserId: ME, createdByRole: "editor" }),
  managedWorkedOn: (c: StatusCategory) => ref({ statusCategory: c, photographerId: ME, createdByUserId: ME, pastEditorIds: [ME, E2] }),
  workedOn: (c: StatusCategory) => ref({ statusCategory: c, editorId: ME, pastEditorIds: [ME] }),
  wasEditor: (c: StatusCategory) => ref({ statusCategory: c, pastEditorIds: [ME, E2] }),
  other: (c: StatusCategory) => ref({ statusCategory: c }),
  otherNoEditor: (c: StatusCategory) => ref({ statusCategory: c, editorId: null, pastEditorIds: [] }),
} as const;
type PhotoSit = keyof typeof PHOTO_SITS;
const PHOTO_ALL = Object.keys(PHOTO_SITS) as PhotoSit[];
const MANAGED: PhotoSit[] = ["own", "shotFor", "creator", "managedWorkedOn"];
const OWNS: PhotoSit[] = ["own", "creator", "managedWorkedOn"];
/** Admins approve everywhere; "worked on" situations need the confirm flag at the service (not a `can()` matter). */
const ADVANCED_ON = { settings: { timezone: "Australia/Sydney", timeTrackingEnabled: true, automationsEnabled: true, advancedToolsEnabled: true } };

/** Situations seen from an editor persona. Draft situations force their own category. */
const EDITOR_SITS = {
  assigned: (c: StatusCategory) => ref({ statusCategory: c, editorId: ME, pastEditorIds: [ME] }),
  past: (c: StatusCategory) => ref({ statusCategory: c, pastEditorIds: [ME, E2] }),
  created: (c: StatusCategory) => ref({ statusCategory: c, createdByUserId: ME, createdByRole: "editor", photographerId: OWNER }),
  draft: () => ref({ statusCategory: "new", createdByUserId: ME, createdByRole: "editor", editorId: null, pastEditorIds: [], draftClosed: false }),
  draftHeld: () =>
    ref({ statusCategory: "accepted", createdByUserId: ME, createdByRole: "editor", editorId: ME, pastEditorIds: [ME], draftClosed: false }),
  draftClosed: () => ref({ statusCategory: "new", createdByUserId: ME, createdByRole: "editor", editorId: null, pastEditorIds: [], draftClosed: true }),
  teamOther: (c: StatusCategory) => ref({ statusCategory: c }),
  otherNoEditor: (c: StatusCategory) => ref({ statusCategory: c, editorId: null, pastEditorIds: [] }),
} as const;
type EditorSit = keyof typeof EDITOR_SITS;
const EDITOR_ALL = Object.keys(EDITOR_SITS) as EditorSit[];
const EDITOR_VISIBLE: EditorSit[] = ["assigned", "past", "created", "draft", "draftHeld", "draftClosed"];

const check = <A extends Action>(c: AuthContext, a: A, r: unknown) => can(c, a, r as ResourceOf<A>);

/* ------------------------------------------------------------------ */
/*  1. Job-scoped matrix: action × persona × situation                 */
/* ------------------------------------------------------------------ */

interface JobRow {
  category: StatusCategory;
  photo: Record<(typeof PHOTO_ACTORS)[number], PhotoSit[]>;
  editor: Record<(typeof EDITOR_ACTORS)[number], EditorSit[]>;
}

const none = { member: [], memberBare: [], memberAll: [] };
const noEditor = { editor: [], editorTeam: [], editorNoCreate: [] };
const sameEditors = (s: EditorSit[]) => ({ editor: s, editorTeam: s, editorNoCreate: s });
const managedMembers = { member: MANAGED, memberBare: MANAGED, memberAll: MANAGED };
const reviewMembers = (sits: PhotoSit[]) => ({ member: sits, memberBare: [] as PhotoSit[], memberAll: sits });
const controlsMembers = { member: MANAGED, memberBare: OWNS, memberAll: MANAGED };

const JOB_MATRIX: Partial<Record<Action, JobRow>> = {
  "job.view": {
    category: "in_progress",
    photo: { admin: PHOTO_ALL, member: MANAGED, memberBare: MANAGED, memberAll: PHOTO_ALL },
    editor: { editor: EDITOR_VISIBLE, editorNoCreate: EDITOR_VISIBLE, editorTeam: [...EDITOR_VISIBLE, "teamOther"] },
  },
  "job.edit_fields": { category: "in_progress", photo: { admin: PHOTO_ALL, ...managedMembers }, editor: sameEditors(["draft", "draftHeld"]) },
  "job.change_client": { category: "in_progress", photo: { admin: PHOTO_ALL, ...controlsMembers }, editor: sameEditors(["draft", "draftHeld"]) },
  "job.set_due_date": { category: "in_progress", photo: { admin: PHOTO_ALL, ...controlsMembers }, editor: sameEditors(["draft", "draftHeld"]) },
  "job.set_priority": { category: "in_progress", photo: { admin: PHOTO_ALL, ...controlsMembers }, editor: sameEditors(["draft", "draftHeld"]) },
  "job.edit_completion_percent": { category: "in_progress", photo: { admin: PHOTO_ALL, ...managedMembers }, editor: sameEditors(["assigned", "draftHeld"]) },
  "job.assign_photographer": { category: "new", photo: { admin: PHOTO_ALL, ...none }, editor: sameEditors(["draft", "draftHeld"]) },
  "job.assign_editor": { category: "new", photo: { admin: PHOTO_ALL, member: MANAGED, memberBare: [], memberAll: MANAGED }, editor: noEditor },
  "job.claim": { category: "new", photo: { admin: [], ...none }, editor: sameEditors(["draft"]) },
  "job.transition": { category: "in_progress", photo: { admin: PHOTO_ALL, ...managedMembers }, editor: sameEditors(["assigned", "draftHeld"]) },
  "job.transition_override": { category: "in_progress", photo: { admin: PHOTO_ALL, ...none }, editor: noEditor },
  "job.accept": { category: "assigned", photo: { admin: PHOTO_ALL, ...none }, editor: sameEditors(["assigned", "draftHeld"]) },
  "job.start": { category: "accepted", photo: { admin: PHOTO_ALL, ...none }, editor: sameEditors(["assigned", "draftHeld"]) },
  "job.submit": { category: "in_progress", photo: { admin: PHOTO_ALL, ...none }, editor: sameEditors(["assigned", "draftHeld"]) },
  "job.decline": { category: "assigned", photo: { admin: [], ...none }, editor: sameEditors(["assigned"]) },
  "job.pause": { category: "in_progress", photo: { admin: PHOTO_ALL, ...none }, editor: sameEditors(["assigned", "draftHeld"]) },
  // SIMPLIFICATION-PLAN §12.3: admins MAY review a job they edited (the service asks them to confirm); members never.
  "job.begin_review": { category: "submitted", photo: { admin: PHOTO_ALL, ...reviewMembers(["own", "shotFor", "creator"]) }, editor: noEditor },
  "job.approve": { category: "submitted", photo: { admin: PHOTO_ALL, ...reviewMembers(["own", "shotFor", "creator"]) }, editor: noEditor },
  "job.deliver": { category: "approved", photo: { admin: PHOTO_ALL, ...reviewMembers(["own", "shotFor", "creator"]) }, editor: noEditor },
  "job.complete": { category: "delivered", photo: { admin: PHOTO_ALL, ...reviewMembers(["own", "shotFor", "creator"]) }, editor: noEditor },
  "revision.request": { category: "submitted", photo: { admin: PHOTO_ALL, ...reviewMembers(["own", "shotFor", "creator"]) }, editor: noEditor },
  "revision.withdraw": { category: "revision", photo: { admin: PHOTO_ALL, ...reviewMembers(["own", "shotFor", "creator"]) }, editor: noEditor },
  "client_feedback.to_revision": {
    category: "delivered",
    photo: { admin: PHOTO_ALL, ...reviewMembers(["own", "shotFor", "creator"]) },
    editor: noEditor,
  },
  "job.reopen": { category: "completed", photo: { admin: PHOTO_ALL, ...reviewMembers(MANAGED) }, editor: noEditor },
  "job.share_with_client": { category: "delivered", photo: { admin: PHOTO_ALL, ...reviewMembers(MANAGED) }, editor: noEditor },
  "client_feedback.reply": { category: "delivered", photo: { admin: PHOTO_ALL, ...reviewMembers(MANAGED) }, editor: noEditor },
  "job.cancel": { category: "in_progress", photo: { admin: PHOTO_ALL, ...controlsMembers }, editor: noEditor },
  "job.restore": { category: "cancelled", photo: { admin: PHOTO_ALL, ...controlsMembers }, editor: noEditor },
  "job.migrate_workflow": { category: "in_progress", photo: { admin: PHOTO_ALL, ...none }, editor: noEditor },
  "revision.resolve": { category: "revision", photo: { admin: PHOTO_ALL, ...none }, editor: sameEditors(["assigned", "draftHeld"]) },
  "comment.add": {
    category: "in_progress",
    photo: { admin: PHOTO_ALL, member: MANAGED, memberBare: MANAGED, memberAll: PHOTO_ALL },
    editor: sameEditors(["assigned", "draft", "draftHeld"]),
  },
  "comment.mention": {
    category: "in_progress",
    photo: { admin: PHOTO_ALL, member: MANAGED, memberBare: MANAGED, memberAll: PHOTO_ALL },
    editor: sameEditors(["assigned", "draft", "draftHeld"]),
  },
  "timer.use": { category: "in_progress", photo: { admin: MANAGED, ...managedMembers }, editor: sameEditors(["assigned", "draftHeld"]) },
  "timer.view_others": { category: "in_progress", photo: { admin: PHOTO_ALL, ...managedMembers }, editor: noEditor },
};
JOB_MATRIX["job.view_history"] = JOB_MATRIX["job.view"];
JOB_MATRIX["job.set_review_due_date"] = JOB_MATRIX["job.set_due_date"];
JOB_MATRIX["job.set_delivery_due_date"] = JOB_MATRIX["job.set_due_date"];

describe("job-scoped matrix (action × persona × situation)", () => {
  const cases: [string, ActorKey, string, boolean, JobPermissionRef][] = [];
  for (const [action, row] of Object.entries(JOB_MATRIX) as [Action, JobRow][]) {
    for (const a of PHOTO_ACTORS)
      for (const sit of PHOTO_ALL) cases.push([action, a, sit, row.photo[a].includes(sit), PHOTO_SITS[sit](row.category)]);
    for (const a of EDITOR_ACTORS)
      for (const sit of EDITOR_ALL) cases.push([action, a, sit, row.editor[a].includes(sit), EDITOR_SITS[sit](row.category)]);
    // clients never act on staff jobs (shared or not)
    for (const a of ["client", "clientNoFeedback"] as const)
      for (const shared of [false, true]) cases.push([action, a, shared ? "shared" : "unshared", false, ref({ statusCategory: row.category, sharedWithClient: shared })]);
  }

  it.each(cases)("%s · %s · %s → %s", (action, a, _sit, expected, job) => {
    expect(check(actor(a), action as Action, job)).toBe(expected);
  });

  it("covers every action whose resource is a job ref", () => {
    const covered = new Set(Object.keys(JOB_MATRIX));
    const jobScoped = ACTIONS.filter((a) => JOB_MATRIX[a] !== undefined || a.startsWith("job.") || a.startsWith("revision."));
    for (const a of jobScoped) if (a !== "job.create" && a !== "job.bulk_reassign") expect(covered.has(a), a).toBe(true);
  });

  it("timer.use needs time tracking on", () => {
    const off = (a: ActorKey) => actor(a, { settings: { timezone: "Australia/Sydney", timeTrackingEnabled: false, automationsEnabled: true } });
    expect(can(off("admin"), "timer.use", PHOTO_SITS.own("in_progress"))).toBe(false);
    expect(can(off("editor"), "timer.use", EDITOR_SITS.assigned("in_progress"))).toBe(false);
    expect(can(actor("editor"), "timer.use", EDITOR_SITS.assigned("submitted"))).toBe(false);
  });

  it("cancel: active jobs only; members never cancel a completed job", () => {
    expect(can(actor("admin"), "job.cancel", PHOTO_SITS.other("cancelled"))).toBe(false);
    expect(can(actor("admin"), "job.cancel", PHOTO_SITS.other("approved"))).toBe(true);
    expect(can(actor("member"), "job.cancel", PHOTO_SITS.own("completed"))).toBe(false);
  });

  it("job.claim needs an unassigned draft in New / Ready", () => {
    expect(can(actor("editor"), "job.claim", { ...EDITOR_SITS.draft(), statusCategory: "ready" })).toBe(true);
    expect(can(actor("editor"), "job.claim", { ...EDITOR_SITS.draft(), statusCategory: "assigned" })).toBe(false);
    expect(can(actor("editor"), "job.claim", EDITOR_SITS.draftClosed())).toBe(false);
  });

  it("managed vs controls: creation counts only when created as a photographer", () => {
    const m = actor("memberBare");
    expect(managesJob(m, PHOTO_SITS.exEditorCreated("new"))).toBe(false);
    expect(controlsJob(m, PHOTO_SITS.shotFor("new"))).toBe(false);
    expect(controlsJob(actor("member"), PHOTO_SITS.shotFor("new"))).toBe(true);
    expect(controlsJob(m, PHOTO_SITS.creator("new"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  2. Resource-less actions                                           */
/* ------------------------------------------------------------------ */

const GLOBAL: [Action, ActorKey[]][] = [
  ["app.access", ["admin", "member", "memberBare", "memberAll", "editor", "editorTeam", "editorNoCreate"]],
  ["portal.access", ["client", "clientNoFeedback"]],
  ["job.create", ["admin", "member", "memberAll", "editor", "editorTeam"]],
  ["job.bulk_reassign", ["admin"]],
  ["analytics.view", ["admin", "memberAll"]],
  ["bottlenecks.view", ["admin", "memberAll"]],
  ["reports.view", ["admin", "memberAll"]],
  ["export.csv", ["admin", "memberAll"]],
  ["performance.view", ["admin", "memberAll"]],
  ["analytics.view_self", ["admin", "member", "memberBare", "memberAll", "editor", "editorTeam", "editorNoCreate"]],
  ["workloads.view_self", ["admin", "member", "memberBare", "memberAll", "editor", "editorTeam", "editorNoCreate"]],
  ["workloads.view_team", ["admin", "memberAll"]],
  ["team.view_members", ["admin", "member", "memberBare", "memberAll"]],
  ["activity.view_global", ["admin", "member", "memberBare", "memberAll", "editor", "editorTeam", "editorNoCreate"]],
  ["activity.view_management_events", ["admin"]],
  ["client.create", ["admin", "member", "memberAll"]],
  ["user.invite", ["admin"]],
  ["team.manage", ["admin"]],
  ["settings.view", ["admin"]],
  ["settings.manage", ["admin"]],
  ["workflow.view", ["admin"]],
  ["workflow.manage", ["admin"]],
  ["job_type.manage", ["admin"]],
  ["automation.manage", ["admin"]],
  ["automation.view_runs", ["admin"]],
  ["saved_view.share", ["admin"]],
  ["search.global", ["admin", "member", "memberBare", "memberAll", "editor", "editorTeam", "editorNoCreate"]],
  ["view.business_scope", ["admin", "memberAll"]],
  ["advanced.view", []],
  ["system.sweep", ["admin"]],
  ["system.integrity", ["admin"]],
];

describe("resource-less actions per persona", () => {
  const cases = GLOBAL.flatMap(([action, allowed]) => ALL_ACTORS.map((a) => [action, a, allowed.includes(a)] as const));
  it.each(cases)("%s · %s → %s", (action, a, expected) => {
    expect(check(actor(a), action, undefined)).toBe(expected);
  });

  it("advanced.view: every staff persona while the studio's Advanced tools switch is on; nobody while off; clients never", () => {
    for (const a of [...PHOTO_ACTORS, ...EDITOR_ACTORS]) {
      expect(can(actor(a), "advanced.view", { feature: "kanban" }), a).toBe(false);
      expect(can(actor(a, ADVANCED_ON), "advanced.view", { feature: "kanban" }), a).toBe(true);
      expect(can(actor(a, ADVANCED_ON), "advanced.view"), a).toBe(true);
    }
    expect(can(actor("client", ADVANCED_ON), "advanced.view", { feature: "kanban" })).toBe(false);
  });

  it("project.create: members with ⚑create; editors only inline from New job", () => {
    const inline = { organisationId: ORG, inlineFromJobCreate: true };
    expect(can(actor("member"), "project.create", { organisationId: ORG })).toBe(true);
    expect(can(actor("memberBare"), "project.create", { organisationId: ORG })).toBe(false);
    expect(can(actor("editor"), "project.create", { organisationId: ORG })).toBe(false);
    expect(can(actor("editor"), "project.create", inline)).toBe(true);
    expect(can(actor("editorNoCreate"), "project.create", inline)).toBe(false);
    expect(can(actor("client"), "project.create", inline)).toBe(false);
  });

  it("management events visible to admins only", () => {
    expect(canSeeManagementEvents(actor("admin"))).toBe(true);
    expect(canSeeManagementEvents(actor("memberAll"))).toBe(false);
    expect(canSeeManagementEvents(actor("editorTeam"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  3. Links, notes, comments                                          */
/* ------------------------------------------------------------------ */

describe("links (§3.3 †)", () => {
  const link = (job: JobPermissionRef, over: Record<string, unknown> = {}) => ({ job, kind: "finished_files" as const, isCurrent: true, ...over });

  it("link.add: admin any kind; member managed; editor working or draft kinds", () => {
    expect(can(actor("admin"), "link.add", link(PHOTO_SITS.other("submitted"), { kind: "gallery" }))).toBe(true);
    expect(can(actor("memberBare"), "link.add", link(PHOTO_SITS.own("in_progress"), { kind: "raw_files" }))).toBe(true);
    expect(can(actor("memberBare"), "link.add", link(PHOTO_SITS.other("in_progress"), { kind: "raw_files" }))).toBe(false);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.assigned("in_progress")))).toBe(true);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.assigned("in_progress"), { kind: "raw_files" }))).toBe(false);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.draft(), { kind: "raw_files" }))).toBe(true);
    // Self-assigned draft ("Assign to me" at creation, still accepted): working AND draft — the draft's raw_files applies.
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.draftHeld(), { kind: "raw_files" }))).toBe(true);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.draftHeld(), { kind: "finished_files" }))).toBe(true);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.draftHeld(), { kind: "client_delivery" }))).toBe(false);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.draft(), { kind: "client_delivery" }))).toBe(false);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.draftClosed(), { kind: "raw_files" }))).toBe(false);
    expect(can(actor("editor"), "link.add", link(EDITOR_SITS.past("in_progress")))).toBe(false);
  });

  it("editors never write links once the job is review-gated", () => {
    for (const c of ["submitted", "review", "resubmitted", "approved", "delivered", "completed"] as const) {
      const job = EDITOR_SITS.assigned(c);
      expect(can(actor("editor"), "link.add", link(job)), c).toBe(false);
      expect(can(actor("editor"), "link.replace", link(job, { addedByUserId: ME })), c).toBe(false);
      expect(can(actor("editor"), "link.remove", link(job, { addedByUserId: ME })), c).toBe(false);
    }
  });

  it("editors replace/remove only their own unshared links", () => {
    const job = EDITOR_SITS.assigned("in_progress");
    expect(can(actor("editor"), "link.replace", link(job, { addedByUserId: ME }))).toBe(true);
    expect(can(actor("editor"), "link.replace", link(job, { addedByUserId: P2 }))).toBe(false);
    expect(can(actor("editor"), "link.remove", link(job, { addedByUserId: ME, sharedWithClient: true }))).toBe(false);
  });

  it("members without ⚑review: client-facing kinds and shared links are blocked once review-gated", () => {
    const gated = PHOTO_SITS.own("approved");
    const open = PHOTO_SITS.own("in_progress");
    expect(can(actor("memberBare"), "link.add", link(gated, { kind: "gallery" }))).toBe(false);
    expect(can(actor("memberBare"), "link.add", link(gated, { kind: "finished_files" }))).toBe(true);
    expect(can(actor("memberBare"), "link.add", link(open, { kind: "gallery" }))).toBe(true);
    expect(can(actor("memberBare"), "link.replace", link(gated, { kind: "reference", sharedWithClient: true }))).toBe(false);
    expect(can(actor("memberBare"), "link.replace", link(gated, { kind: "reference" }))).toBe(true);
    expect(can(actor("member"), "link.add", link(gated, { kind: "gallery" }))).toBe(true);
    expect(can(actor("member"), "link.remove", link(gated, { kind: "client_delivery", sharedWithClient: true }))).toBe(true);
  });

  it("link.share_with_client: current links; admin, or member managed ∧ ⚑review", () => {
    expect(can(actor("admin"), "link.share_with_client", link(PHOTO_SITS.other("delivered")))).toBe(true);
    expect(can(actor("admin"), "link.share_with_client", link(PHOTO_SITS.other("delivered"), { isCurrent: false }))).toBe(false);
    expect(can(actor("member"), "link.share_with_client", link(PHOTO_SITS.shotFor("delivered")))).toBe(true);
    expect(can(actor("memberBare"), "link.share_with_client", link(PHOTO_SITS.own("delivered")))).toBe(false);
    expect(can(actor("memberAll"), "link.share_with_client", link(PHOTO_SITS.other("delivered")))).toBe(false);
    expect(can(actor("editor"), "link.share_with_client", link(EDITOR_SITS.assigned("in_progress")))).toBe(false);
  });
});

describe("notes (§2.4)", () => {
  const note = (job: JobPermissionRef, kind: (typeof NOTE_KINDS)[number], authorUserId?: string) => ({ job, kind, authorUserId });

  it("note.read: editors never internal/client notes; members internal only on managed jobs", () => {
    for (const kind of NOTE_KINDS) {
      expect(can(actor("editor"), "note.read", note(EDITOR_SITS.assigned("in_progress"), kind)), kind).toBe(kind !== "internal" && kind !== "client");
      expect(can(actor("admin"), "note.read", note(PHOTO_SITS.other("in_progress"), kind)), kind).toBe(true);
    }
    expect(can(actor("memberAll"), "note.read", note(PHOTO_SITS.other("in_progress"), "internal"))).toBe(false);
    expect(can(actor("memberAll"), "note.read", note(PHOTO_SITS.other("in_progress"), "client"))).toBe(true);
    expect(can(actor("memberBare"), "note.read", note(PHOTO_SITS.own("in_progress"), "internal"))).toBe(true);
    expect(can(actor("editor"), "note.read", note(EDITOR_SITS.teamOther("in_progress"), "editor"))).toBe(false);
    expect(can(actor("editorTeam"), "note.read", note(EDITOR_SITS.teamOther("in_progress"), "delivery"))).toBe(true);
    expect(can(actor("client"), "note.read", note(PHOTO_SITS.other("delivered"), "delivery"))).toBe(false);
  });

  it("note.add kinds per persona; delivery notes need ⚑review for members", () => {
    const own = PHOTO_SITS.own("in_progress");
    expect(can(actor("memberBare"), "note.add", note(own, "photographer"))).toBe(true);
    expect(can(actor("memberBare"), "note.add", note(own, "client"))).toBe(true);
    expect(can(actor("memberBare"), "note.add", note(own, "internal"))).toBe(false);
    expect(can(actor("memberBare"), "note.add", note(own, "delivery"))).toBe(false);
    expect(can(actor("member"), "note.add", note(own, "delivery"))).toBe(true);
    expect(can(actor("admin"), "note.add", note(PHOTO_SITS.other("in_progress"), "internal"))).toBe(true);
    expect(can(actor("editor"), "note.add", note(EDITOR_SITS.assigned("in_progress"), "editor"))).toBe(true);
    expect(can(actor("editor"), "note.add", note(EDITOR_SITS.draft(), "revision"))).toBe(true);
    expect(can(actor("editor"), "note.add", note(EDITOR_SITS.assigned("in_progress"), "delivery"))).toBe(false);
    expect(can(actor("editor"), "note.add", note(EDITOR_SITS.past("in_progress"), "editor"))).toBe(false);
    expect(can(actor("editor"), "note.edit", note(EDITOR_SITS.assigned("in_progress"), "editor", ME))).toBe(true);
    expect(can(actor("editor"), "note.edit", note(EDITOR_SITS.assigned("in_progress"), "editor", P2))).toBe(false);
  });
});

describe("comments (§3.3 ‡, §7.5)", () => {
  const recent = "2026-10-09T02:50:00.000Z";
  const old = "2026-10-09T02:44:59.999Z";
  const comment = (job: JobPermissionRef, over: Record<string, unknown> = {}) => ({
    job,
    authorUserId: ME,
    createdAt: recent,
    deletedAt: null,
    kind: "comment" as const,
    rootKind: "comment" as const,
    ...over,
  });

  it("comment.edit: own comment within 15 minutes and still allowed to write on the job", () => {
    expect(can(actor("editor"), "comment.edit", comment(EDITOR_SITS.assigned("in_progress")))).toBe(true);
    expect(can(actor("editor"), "comment.edit", comment(EDITOR_SITS.assigned("in_progress"), { createdAt: "2026-10-09T02:45:00.000Z" }))).toBe(true);
    expect(can(actor("editor"), "comment.edit", comment(EDITOR_SITS.assigned("in_progress"), { createdAt: old }))).toBe(false);
    expect(can(actor("editor"), "comment.edit", comment(EDITOR_SITS.past("in_progress")))).toBe(false);
    expect(can(actor("admin"), "comment.edit", comment(PHOTO_SITS.other("in_progress"), { authorUserId: P2 }))).toBe(false);
    expect(can(actor("memberAll"), "comment.edit", comment(PHOTO_SITS.other("in_progress")))).toBe(true);
  });

  it("comment.delete: admin any; others own where they may write", () => {
    expect(can(actor("admin"), "comment.delete", comment(PHOTO_SITS.other("in_progress"), { authorUserId: P2 }))).toBe(true);
    expect(can(actor("editor"), "comment.delete", comment(EDITOR_SITS.assigned("in_progress"), { authorUserId: P2 }))).toBe(false);
    expect(can(actor("editor"), "comment.delete", comment(EDITOR_SITS.assigned("in_progress")))).toBe(true);
    expect(can(actor("editorTeam"), "comment.delete", comment(EDITOR_SITS.teamOther("in_progress")))).toBe(false);
  });

  it("clients edit/delete only their own client_feedback on shared jobs (edit needs feedback on)", () => {
    const shared = ref({ statusCategory: "delivered", sharedWithClient: true });
    const fb = comment(shared, { kind: "client_feedback", rootKind: "client_feedback" });
    expect(can(actor("client"), "comment.edit", fb)).toBe(true);
    expect(can(actor("clientNoFeedback"), "comment.edit", fb)).toBe(false);
    expect(can(actor("clientNoFeedback"), "comment.delete", fb)).toBe(true);
    expect(can(actor("client"), "comment.edit", { ...fb, createdAt: old })).toBe(false);
    expect(can(actor("client"), "comment.edit", { ...fb, kind: "comment" })).toBe(false);
    expect(can(actor("client"), "comment.delete", { ...fb, authorUserId: P2 })).toBe(false);
    expect(can(actor("client"), "comment.delete", { ...fb, job: ref({ statusCategory: "delivered" }) })).toBe(false);
    expect(can(actor("client"), "comment.delete", { ...fb, job: ref({ statusCategory: "delivered", sharedWithClient: true, clientId: "c-2" }) })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  4. Users, clients/projects, self                                   */
/* ------------------------------------------------------------------ */

describe("users (§3.3, §3.4)", () => {
  const target = (over: Record<string, unknown> = {}) => ({ id: P2, role: "photographer" as const, isActive: true, organisationId: ORG, isAdmin: false, isPrimaryOwner: false, ...over });

  it("only admins administer users; others edit / reset themselves", () => {
    for (const a of ["member", "memberAll", "editor", "client"] as const) {
      expect(can(actor(a), "user.edit", target({ id: ME }))).toBe(true);
      expect(can(actor(a), "user.edit", target())).toBe(false);
      expect(can(actor(a), "user.reset_password", target({ id: ME }))).toBe(true);
      expect(can(actor(a), "user.reset_password", target())).toBe(false);
      expect(can(actor(a), "user.deactivate", target())).toBe(false);
      expect(can(actor(a), "user.set_admin", target())).toBe(false);
    }
    expect(can(actor("admin"), "user.edit", target())).toBe(true);
    expect(can(actor("admin"), "user.reset_password", target({ role: "client" }))).toBe(true);
  });

  it("change_role: photographer ⇄ editor only, never self, never to/from client", () => {
    expect(can(actor("admin"), "user.change_role", target({ nextRole: "editor" }))).toBe(true);
    expect(can(actor("admin"), "user.change_role", target({ role: "editor", nextRole: "photographer" }))).toBe(true);
    expect(can(actor("admin"), "user.change_role", target({ nextRole: "client" }))).toBe(false);
    expect(can(actor("admin"), "user.change_role", target({ role: "client", nextRole: "editor" }))).toBe(false);
    expect(can(actor("admin"), "user.change_role", target({ id: ME, nextRole: "editor" }))).toBe(false);
  });

  it("set_admin: active photographers, not self; set_permissions: active non-admin members and editors", () => {
    expect(can(actor("admin"), "user.set_admin", target())).toBe(true);
    expect(can(actor("admin"), "user.set_admin", target({ id: ME }))).toBe(false);
    expect(can(actor("admin"), "user.set_admin", target({ role: "editor" }))).toBe(false);
    expect(can(actor("admin"), "user.set_admin", target({ isActive: false }))).toBe(false);
    expect(can(actor("admin"), "user.set_permissions", target())).toBe(true);
    expect(can(actor("admin"), "user.set_permissions", target({ role: "editor" }))).toBe(true);
    expect(can(actor("admin"), "user.set_permissions", target({ isAdmin: true }))).toBe(false);
    expect(can(actor("admin"), "user.set_permissions", target({ role: "client" }))).toBe(false);
  });

  it("deactivate not self; anonymise only deactivated users", () => {
    expect(can(actor("admin"), "user.deactivate", target({ id: ME }))).toBe(false);
    expect(can(actor("admin"), "user.deactivate", target())).toBe(true);
    expect(can(actor("admin"), "user.anonymise", target())).toBe(false);
    expect(can(actor("admin"), "user.anonymise", target({ isActive: false }))).toBe(true);
  });

  it("user.view: admins full; members/editors staff only (client ids hidden)", () => {
    expect(can(actor("member"), "user.view", target())).toBe(true);
    expect(can(actor("editor"), "user.view", target({ role: "client" }))).toBe(false);
    expect(can(actor("admin"), "user.view", target({ role: "client" }))).toBe(true);
    expect(can(actor("client"), "user.view", target())).toBe(false);
  });

  it("primary-owner protection: other admins cannot touch the primary owner; the primary owner can self-serve", () => {
    const po = target({ isAdmin: true, isPrimaryOwner: true });
    for (const action of PRIMARY_OWNER_PROTECTED_ACTIONS) {
      const r = { ...po, nextRole: action === "user.change_role" ? ("editor" as const) : undefined };
      expect(check(actor("admin"), action, action === "user.anonymise" ? { ...r, isActive: false } : r), action).toBe(false);
      expect(hardRuleDenial(actor("admin"), action, r), action).toBe("primary_owner");
    }
    const self = actor("admin", { isPrimaryOwner: true });
    expect(can(self, "user.edit", { ...po, id: ME })).toBe(true);
    expect(can(self, "user.change_email", { ...po, id: ME })).toBe(true);
    expect(can(self, "user.reset_password", { ...po, id: ME })).toBe(true);
    expect(can(self, "user.deactivate", { ...po, id: ME })).toBe(false);
    expect(can(actor("admin"), "user.change_email", target())).toBe(true);
  });

  it("org.transfer_primary_owner: primary owner only, to another active admin", () => {
    const self = actor("admin", { isPrimaryOwner: true });
    expect(can(self, "org.transfer_primary_owner", target({ isAdmin: true }))).toBe(true);
    expect(can(self, "org.transfer_primary_owner", target())).toBe(false);
    expect(can(self, "org.transfer_primary_owner", target({ isAdmin: true, isActive: false }))).toBe(false);
    expect(can(self, "org.transfer_primary_owner", target({ id: ME, isAdmin: true }))).toBe(false);
    expect(can(actor("admin"), "org.transfer_primary_owner", target({ isAdmin: true }))).toBe(false);
  });
});

describe("clients, projects, self-scoped", () => {
  it("clients/projects", () => {
    expect(can(actor("memberBare"), "client.edit", { organisationId: ORG, createdByUserId: ME })).toBe(true);
    expect(can(actor("memberBare"), "client.edit", { organisationId: ORG, createdByUserId: P2 })).toBe(false);
    expect(can(actor("admin"), "client.edit", { organisationId: ORG, createdByUserId: P2 })).toBe(true);
    expect(can(actor("editor"), "project.view", { organisationId: ORG, hasVisibleJob: false })).toBe(false);
    expect(can(actor("editor"), "project.view", { organisationId: ORG, hasVisibleJob: true })).toBe(true);
    expect(can(actor("member"), "client.archive", { organisationId: ORG })).toBe(false);
    expect(can(actor("admin"), "client.manage_portal", { organisationId: ORG })).toBe(true);
    expect(can(actor("memberAll"), "client.manage_portal", { organisationId: ORG })).toBe(false);
    expect(can(actor("memberAll"), "project.share_with_client", { organisationId: ORG })).toBe(false);
    expect(can(actor("client"), "client.view", { organisationId: ORG })).toBe(false);
  });

  it("self-scoped resources (clients included for notifications)", () => {
    expect(can(actor("editor"), "notification.read", { userId: ME })).toBe(true);
    expect(can(actor("admin"), "notification.read", { userId: P2 })).toBe(false);
    expect(can(actor("client"), "notification.prefs", { userId: ME })).toBe(true);
    expect(can(actor("client"), "saved_view.manage", { userId: ME })).toBe(false);
    expect(can(actor("client"), "dashboard.customise", { userId: ME })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  5. Portal                                                          */
/* ------------------------------------------------------------------ */

describe("portal (§7.2)", () => {
  const recentCancel = "2026-09-20T00:00:00.000Z"; // 19 days before NOW
  const oldCancel = "2026-09-01T00:00:00.000Z"; // 38 days before NOW
  const pj = (over: Partial<JobPermissionRef> = {}) => ref({ statusCategory: "delivered", ...over });
  const cases: [string, JobPermissionRef, boolean, boolean][] = [
    // situation, ref, portal.view_job, portal.give_feedback
    ["shared (job)", pj({ sharedWithClient: true }), true, true],
    ["shared (project)", pj({ projectSharedWithClient: true }), true, true],
    ["unshared", pj(), false, false],
    ["other client", pj({ sharedWithClient: true, clientId: "c-2" }), false, false],
    ["cancelled shared < 30 d", pj({ sharedWithClient: true, statusCategory: "cancelled", cancelledAt: recentCancel }), true, false],
    ["cancelled shared > 30 d", pj({ sharedWithClient: true, statusCategory: "cancelled", cancelledAt: oldCancel }), false, false],
    ["other org", pj({ sharedWithClient: true, organisationId: "org-2" }), false, false],
  ];
  it.each(cases)("client · %s", (_s, job, view, feedback) => {
    expect(can(actor("client"), "portal.view_job", job)).toBe(view);
    expect(can(actor("client"), "portal.give_feedback", job)).toBe(feedback);
    expect(can(actor("clientNoFeedback"), "portal.view_job", job)).toBe(view);
    expect(can(actor("clientNoFeedback"), "portal.give_feedback", job)).toBe(false);
    for (const staff of [...PHOTO_ACTORS, ...EDITOR_ACTORS]) {
      expect(can(actor(staff), "portal.view_job", job)).toBe(false);
      expect(can(actor(staff), "portal.give_feedback", job)).toBe(false);
    }
  });

  it("clients never get job.view, and a client without a client id sees nothing", () => {
    expect(canViewJob(actor("client"), pj({ sharedWithClient: true }))).toBe(false);
    expect(can(actor("client", { clientId: null }), "portal.view_job", pj({ sharedWithClient: true }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  6. Structure + hard rules                                          */
/* ------------------------------------------------------------------ */

/** Every resource shape worth trying for an action (for the "ever" sweeps). */
function resourcesFor(action: Action): unknown[] {
  const out: unknown[] = [undefined];
  const cats: StatusCategory[] = ["new", "assigned", "accepted", "in_progress", "submitted", "revision", "approved", "delivered", "completed", "cancelled"];
  const jobs: JobPermissionRef[] = [];
  for (const c of cats) {
    for (const f of Object.values(PHOTO_SITS)) jobs.push(f(c));
    for (const f of Object.values(EDITOR_SITS)) jobs.push(f(c));
    jobs.push(ref({ statusCategory: c, sharedWithClient: true, cancelledAt: "2026-10-01T00:00:00.000Z" }));
    jobs.push(ref({ statusCategory: c, organisationId: "org-2", photographerId: ME, editorId: ME, createdByUserId: ME, sharedWithClient: true }));
  }
  if (action.startsWith("link.")) {
    for (const j of jobs) for (const kind of LINK_KINDS) for (const by of [ME, P2]) for (const sharedWithClient of [false, true]) out.push({ job: j, kind, addedByUserId: by, isCurrent: true, sharedWithClient });
    return out;
  }
  if (action.startsWith("note.")) {
    for (const j of jobs) for (const kind of NOTE_KINDS) for (const by of [ME, P2]) out.push({ job: j, kind, authorUserId: by });
    return out;
  }
  if (action === "comment.edit" || action === "comment.delete") {
    for (const j of jobs)
      for (const by of [ME, P2])
        for (const kind of ["comment", "client_feedback"] as const)
          for (const createdAt of ["2026-10-09T02:50:00.000Z", "2026-10-09T01:00:00.000Z"]) out.push({ job: j, authorUserId: by, createdAt, deletedAt: null, kind, rootKind: kind });
    return out;
  }
  if (action.startsWith("client.") || action.startsWith("project.")) {
    for (const by of [ME, P2]) for (const v of [true, false]) for (const inline of [true, false]) out.push({ organisationId: ORG, createdByUserId: by, hasVisibleJob: v, inlineFromJobCreate: inline });
    out.push({ organisationId: "org-2", createdByUserId: ME });
    return out;
  }
  if (action.startsWith("user.") || action === "org.transfer_primary_owner") {
    for (const id of [ME, P2])
      for (const role of ["photographer", "editor", "client"] as const)
        for (const isActive of [true, false])
          for (const isAdmin of [false, true])
            for (const nextRole of [undefined, "photographer", "editor"] as const) out.push({ id, role, isActive, isAdmin, isPrimaryOwner: false, organisationId: ORG, nextRole });
    out.push({ id: P2, role: "editor", isActive: true, organisationId: "org-2" });
    return out;
  }
  if (["notification.read", "notification.prefs", "saved_view.manage", "dashboard.customise"].includes(action)) {
    out.push({ userId: ME }, { userId: P2 });
    return out;
  }
  return [...out, ...jobs];
}

function personaVariants(p: Persona): AuthContext[] {
  switch (p) {
    case "admin":
      return [actor("admin"), actor("admin", { isPrimaryOwner: true }), actor("admin", ADVANCED_ON)];
    case "member":
      return [actor("memberBare"), actor("member"), actor("memberAll"), actor("memberAll", ADVANCED_ON)];
    case "editor":
      return [actor("editorNoCreate"), actor("editor"), actor("editorTeam"), actor("editorTeam", ADVANCED_ON)];
    case "client":
      return [actor("client"), actor("clientNoFeedback"), actor("client", ADVANCED_ON)];
  }
}

describe("POLICY ↔ PERMISSIONS", () => {
  it("covers every action exactly", () => {
    expect(Object.keys(POLICY).sort()).toEqual([...ACTIONS].sort());
  });

  it("scope notes are declared for exactly the personas PERMISSIONS lists", () => {
    for (const action of ACTIONS) {
      const rule = ruleMeta(action);
      expect(Object.keys(rule.scope).sort(), action).toEqual([...PERMISSIONS[action]].sort());
    }
  });

  it("the personas for which can() is ever true equal PERMISSIONS[action]", () => {
    for (const action of ACTIONS) {
      const resources = resourcesFor(action);
      const ever = PERSONAS.filter((p) => personaVariants(p).some((c) => resources.some((r) => check(c, action, r))));
      expect(ever.sort(), action).toEqual([...PERMISSIONS[action]].sort());
    }
  });

  it("personaOf: system → admin; photographer by is_admin", () => {
    expect(personaOf(actor("admin"))).toBe("admin");
    expect(personaOf(actor("memberAll"))).toBe("member");
    expect(personaOf(actor("editor"))).toBe("editor");
    expect(personaOf(actor("client"))).toBe("client");
    expect(personaOf(actor("memberBare", { isSystem: true, userId: null }))).toBe("admin");
    for (const action of ACTIONS) for (const p of PERSONAS) expect(personaMayEver(p, action)).toBe((PERMISSIONS[action] as readonly Persona[]).includes(p));
  });
});

describe("memberFlag / editorFlag are set exactly on flag-gated cells", () => {
  const flagOff = (key: ActorKey, flag: MemberFlag | EditorFlag) => actor(key, { [flag]: false });

  it("a declared flag gates the cell: with it off nothing is allowed, with every switch on something is", () => {
    for (const action of ACTIONS) {
      const rule = ruleMeta(action);
      const resources = resourcesFor(action);
      if (rule.memberFlag) {
        expect(resources.some((r) => check(actor("memberAll"), action, r)), `${action} member on`).toBe(true);
        expect(resources.some((r) => check(flagOff("memberAll", rule.memberFlag as MemberFlag), action, r)), `${action} member off`).toBe(false);
      }
      if (rule.editorFlag) {
        expect(resources.some((r) => check(actor("editorTeam"), action, r)), `${action} editor on`).toBe(true);
        expect(resources.some((r) => check(flagOff("editorTeam", rule.editorFlag as EditorFlag), action, r)), `${action} editor off`).toBe(false);
      }
    }
  });

  it("an undeclared flag never gates: a member / editor with every switch off can still do it somewhere", () => {
    for (const action of ACTIONS) {
      const rule = ruleMeta(action);
      const resources = resourcesFor(action);
      // advanced.view is gated by the studio switch, not a person's switch: test it with the switch on.
      const over = action === "advanced.view" ? ADVANCED_ON : {};
      if (!rule.memberFlag && personaMayEver("member", action)) {
        expect(resources.some((r) => check(actor("memberBare", over), action, r)), `${action} member`).toBe(true);
      }
      if (!rule.editorFlag && personaMayEver("editor", action)) {
        expect(resources.some((r) => check(actor("editorNoCreate", over), action, r)), `${action} editor`).toBe(true);
      }
    }
  });

  it("flag keys are real switches", () => {
    for (const action of ACTIONS) {
      const rule = ruleMeta(action);
      if (rule.memberFlag) expect(MEMBER_FLAGS).toContain(rule.memberFlag);
      if (rule.editorFlag) expect(EDITOR_FLAGS).toContain(rule.editorFlag);
    }
  });
});

describe("hard rules", () => {
  it("inactive actors are denied everything", () => {
    for (const action of ACTIONS)
      for (const a of ALL_ACTORS) {
        const c = actor(a, { isActive: false });
        for (const r of resourcesFor(action)) expect(check(c, action, r), `${a} ${action}`).toBe(false);
      }
  });

  it("resources from another organisation are denied for every persona and action", () => {
    for (const action of ACTIONS)
      for (const a of ALL_ACTORS) {
        const foreign = resourcesFor(action).filter((r) => {
          if (typeof r !== "object" || r === null) return false;
          const o = r as { organisationId?: string; job?: { organisationId: string } };
          return o.organisationId === "org-2" || o.job?.organisationId === "org-2";
        });
        for (const r of foreign) expect(check(actor(a), action, r), `${a} ${action}`).toBe(false);
      }
  });

  it("system context may only perform the automation allowlist", () => {
    const sys = actor("admin", { isSystem: true, userId: null });
    for (const action of ACTIONS) {
      const r = action === "note.add" ? { job: PHOTO_SITS.other("in_progress"), kind: "internal" } : JOB_MATRIX[action] ? PHOTO_SITS.other("in_progress") : undefined;
      expect(check(sys, action, r), action).toBe(SYSTEM_ACTION_ALLOWLIST.has(action));
    }
    expect([...SYSTEM_ACTION_ALLOWLIST].sort()).toEqual(["job.assign_editor", "job.set_priority", "job.transition", "job.view", "note.add"]);
    expect(can(sys, "job.transition", ref({ organisationId: "org-2" }))).toBe(false);
  });

  it("a non-system context without a user id is denied", () => {
    expect(can(actor("admin", { userId: null }), "job.view", PHOTO_SITS.other("new"))).toBe(false);
  });

  it("self-review (SIMPLIFICATION-PLAN §12.3): editors and non-admin photographers who edited the job never review it; owners / co-owners may, after confirming", () => {
    const edited = (c: StatusCategory) => ref({ statusCategory: c, photographerId: ME, createdByUserId: ME, editorId: ME, pastEditorIds: [ME] });
    const wasEditor = (c: StatusCategory) => ref({ statusCategory: c, photographerId: ME, createdByUserId: ME, pastEditorIds: [ME, E2] });
    const nonAdmins = ALL_ACTORS.filter((a) => a !== "admin");
    for (const action of SELF_REVIEW_ACTIONS)
      for (const c of ["submitted", "review", "resubmitted", "approved", "delivered", "revision"] as const) {
        for (const a of nonAdmins) {
          expect(check(actor(a), action, edited(c)), `${a} ${action} ${c}`).toBe(false);
          expect(check(actor(a), action, wasEditor(c)), `${a} ${action} ${c}`).toBe(false);
        }
        // the admin is allowed by the policy; the service demands confirmSelfApproval for the approve-side actions
        expect(check(actor("admin"), action, edited(c)), `admin ${action} ${c}`).toBe(true);
        expect(check(actor("admin"), action, wasEditor(c)), `admin ${action} ${c}`).toBe(true);
      }
    expect(hardRuleDenial(actor("member"), "job.approve", edited("submitted"))).toBe("self_review");
    expect(hardRuleDenial(actor("editor"), "job.approve", edited("submitted"))).toBe("self_review");
    expect(hardRuleDenial(actor("admin"), "job.approve", edited("submitted"))).toBeNull();
    expect(selfReviewBlocked(actor("member"), edited("submitted"))).toBe(true);
    expect(selfReviewBlocked(actor("admin"), edited("submitted"))).toBe(false);
    expect(selfReviewNeedsConfirm(actor("admin"), edited("submitted"))).toBe(true);
    expect(selfReviewNeedsConfirm(actor("admin"), PHOTO_SITS.own("submitted"))).toBe(false);
    expect(selfReviewNeedsConfirm(actor("member"), edited("submitted"))).toBe(false);
    for (const action of SELF_APPROVAL_CONFIRM_ACTIONS) expect(actionNeedsSelfApprovalConfirm(actor("admin"), action, wasEditor("submitted")), action).toBe(true);
    expect(actionNeedsSelfApprovalConfirm(actor("admin"), "revision.request", wasEditor("submitted"))).toBe(false);
    expect(actionNeedsSelfApprovalConfirm(actor("admin"), "job.approve", PHOTO_SITS.own("submitted"))).toBe(false);
    // the system context never confirms anything
    expect(selfReviewNeedsConfirm(actor("admin", { isSystem: true, userId: null }), edited("submitted"))).toBe(false);
    // a photographer approving an editor's work on a job they shot and created is the normal review
    expect(can(actor("member"), "job.approve", PHOTO_SITS.own("submitted"))).toBe(true);
  });

  it("invite presets (plan §2, decision 4): own_shoots / co_owner, explicit switches win, custom detection", () => {
    expect(inviteSwitchesFor("own_shoots")).toEqual({
      isAdmin: false,
      flags: { canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewAllJobs: false, canViewTeamWorkloads: false, canViewAnalytics: false },
    });
    expect(inviteSwitchesFor("co_owner").isAdmin).toBe(true);
    expect(inviteSwitchesFor("own_shoots", { flags: { canViewAllJobs: true } }).flags.canViewAllJobs).toBe(true);
    expect(inviteSwitchesFor("co_owner", { isAdmin: false }).isAdmin).toBe(false);
    expect(inviteSwitchesFor(undefined, { flags: { canCreateJobs: false } })).toEqual({ isAdmin: undefined, flags: { canCreateJobs: false } });
    expect(photographerPresetOf({ role: "photographer", isAdmin: true })).toBe("co_owner");
    expect(photographerPresetOf({ role: "photographer", isAdmin: false, ...PHOTOGRAPHER_PRESET_META.own_shoots.flags })).toBe("own_shoots");
    expect(photographerPresetOf({ role: "photographer", isAdmin: false, ...PHOTOGRAPHER_PRESET_META.own_shoots.flags, canViewAllJobs: true })).toBe("custom");
    expect(photographerPresetOf({ role: "editor" })).toBeNull();
  });

  it("assertCan throws ForbiddenError carrying the action", () => {
    expect(() => assertCan(actor("editor"), "settings.manage")).toThrow(ForbiddenError);
    try {
      assertCan(actor("editor"), "job.approve", EDITOR_SITS.assigned("submitted"));
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).action).toBe("job.approve");
      expect((e as ForbiddenError).status).toBe(403);
    }
    expect(() => assertCan(actor("admin"), "settings.manage")).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  7. SQL twins (rendering; behaviour in visibleJobs.pg.test.ts)      */
/* ------------------------------------------------------------------ */

describe("visibleJobsWhere / portalJobsWhere (SQL shape)", () => {
  const dialect = new PgDialect();
  const render = (sqlExpr: ReturnType<typeof visibleJobsWhere>) => dialect.sqlToQuery(sqlExpr);

  it.each(ALL_ACTORS)("compiles for %s and always filters by organisation", (a) => {
    for (const where of [visibleJobsWhere(actor(a)), portalJobsWhere(actor(a))]) {
      const q = render(where);
      expect(q.sql).toContain('"organisation_id"');
      expect(q.params).toContain(ORG);
    }
  });

  it("admin / ⚑all member / system: organisation filter only", () => {
    for (const c of [actor("admin"), actor("memberAll"), actor("memberBare", { isSystem: true, userId: null })]) {
      expect(render(visibleJobsWhere(c))).toMatchObject({ sql: '"jobs"."organisation_id" = $1', params: [ORG] });
    }
  });

  it("member: photographer or created-as-photographer", () => {
    const q = render(visibleJobsWhere(actor("member")));
    expect(q.sql).toContain('"photographer_id"');
    expect(q.sql).toContain('"created_by_role"');
  });

  it("editor: assigned ∨ past ∨ created, + any held job with ⚑teamJobs", () => {
    const plain = render(visibleJobsWhere(actor("editor")));
    expect(plain.sql).toMatch(/exists \(select 1 from "job_assignments"/);
    expect(plain.sql).toContain('"created_by_user_id"');
    expect(plain.sql).not.toContain("is not null");
    expect(render(visibleJobsWhere(actor("editorTeam"))).sql).toContain('"jobs"."editor_id" is not null');
  });

  it("clients, inactive and user-less actors match nothing; staff get no portal rows", () => {
    for (const c of [actor("client"), actor("admin", { isActive: false }), actor("editor", { userId: null })]) {
      expect(render(visibleJobsWhere(c)).sql).toContain("1 = 0");
    }
    for (const a of [...PHOTO_ACTORS, ...EDITOR_ACTORS]) expect(render(portalJobsWhere(actor(a))).sql).toContain("1 = 0");
    const portal = render(portalJobsWhere(actor("client")));
    expect(portal.params).toContain(CLIENT);
    expect(portal.sql).toContain('"shared_with_client"');
  });
});

/* ------------------------------------------------------------------ */
/*  8. Roles page matrix                                               */
/* ------------------------------------------------------------------ */

describe("permissionMatrix", () => {
  const matrix = permissionMatrix();

  it("has one row per action with cells derived from PERMISSIONS, naming the switch a member/editor needs", () => {
    expect(matrix.map((r) => r.action)).toEqual([...ACTIONS]);
    for (const row of matrix) {
      expect(row.label.length).toBeGreaterThan(0);
      const rule = ruleMeta(row.action);
      for (const p of PERSONAS) {
        expect(row.cells[p].allowed).toBe(personaMayEver(p, row.action));
        if (!row.cells[p].allowed) expect(row.cells[p].scope).toBe("never");
      }
      expect(row.cells.member.memberFlag).toBe(row.cells.member.allowed ? rule.memberFlag : undefined);
      expect(row.cells.editor.editorFlag).toBe(row.cells.editor.allowed ? rule.editorFlag : undefined);
    }
  });

  it("snapshot (persona columns: allowed / scope / switch)", () => {
    const compact = matrix.map((r) => [
      r.action,
      ...PERSONAS.map((p) => (r.cells[p].allowed ? `${r.cells[p].scope}${r.cells[p].memberFlag ? ` [${r.cells[p].memberFlag}]` : ""}${r.cells[p].editorFlag ? ` [${r.cells[p].editorFlag}]` : ""}` : "-")),
    ]);
    expect(compact).toMatchSnapshot();
  });
});
