import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  ACTIONS,
  LINK_KINDS,
  NOTE_KINDS,
  PERMISSIONS,
  ROLES,
  type Action,
  type Role,
  type StatusCategory,
} from "@/lib/constants";
import type { AuthContext, ContextSettings, JobPermissionRef } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";
import {
  POLICY,
  SYSTEM_ACTION_ALLOWLIST,
  assertCan,
  can,
  canSeeManagementEvents,
  permissionMatrix,
  roleCanEver,
  visibleJobsWhere,
  type ResourceOf,
} from "./permissions";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ORG = "org-1";
const ME = "u-me";
const TEAMMATE = "u-team";
const STRANGER = "u-other";
const NOW = "2026-10-09T03:00:00.000Z";

const BASE_SETTINGS: ContextSettings = {
  timezone: "Australia/Sydney",
  timeTrackingEnabled: true,
  photographersSeeAllJobs: false,
  photographersSeeTeamJobs: false,
  editorsSeeTeamJobs: false,
  editorsSeeTeamWorkloads: false,
  automationsEnabled: true,
};

function ctx(role: Role, over: Partial<AuthContext> = {}, settings: Partial<ContextSettings> = {}): AuthContext {
  return {
    userId: ME,
    organisationId: ORG,
    role,
    isActive: true,
    canViewTeamWorkloads: false,
    canViewAnalytics: false,
    teamUserIds: new Set([TEAMMATE]),
    settings: { ...BASE_SETTINGS, ...settings },
    isSystem: false,
    now: () => NOW,
    requestId: "req-test",
    ...over,
  };
}

const ALL_FLAGS: Partial<ContextSettings> = {
  photographersSeeAllJobs: true,
  photographersSeeTeamJobs: true,
  editorsSeeTeamJobs: true,
  editorsSeeTeamWorkloads: true,
};

type Situation = "own" | "createdBy" | "assigned" | "past" | "team" | "other" | "otherOrg";

function job(sit: Situation, statusCategory: StatusCategory = "in_progress"): JobPermissionRef {
  const base: JobPermissionRef = {
    id: `job-${sit}`,
    organisationId: ORG,
    photographerId: STRANGER,
    editorId: STRANGER,
    createdByUserId: STRANGER,
    statusCategory,
    isPaused: false,
    pastEditorIds: [STRANGER],
  };
  switch (sit) {
    case "own":
      return { ...base, photographerId: ME };
    case "createdBy":
      return { ...base, createdByUserId: ME };
    case "assigned":
      return { ...base, editorId: ME, pastEditorIds: [ME] };
    case "past":
      return { ...base, pastEditorIds: [ME, STRANGER] };
    case "team":
      return { ...base, photographerId: TEAMMATE };
    case "other":
      return base;
    case "otherOrg":
      return { ...base, organisationId: "org-2", photographerId: ME, editorId: ME, createdByUserId: ME, pastEditorIds: [ME] };
  }
}

const SITUATIONS: Situation[] = ["own", "createdBy", "assigned", "past", "team", "other", "otherOrg"];
const CATEGORIES: StatusCategory[] = ["new", "assigned", "accepted", "in_progress", "submitted", "revision", "approved", "completed", "cancelled"];

const JOB_PREFIXES = ["job.", "revision.", "timer."];
const isJobAction = (a: Action) =>
  (JOB_PREFIXES.some((p) => a.startsWith(p)) && a !== "job.create" && a !== "job.bulk_reassign") || a === "comment.add" || a === "comment.mention";

/** Every resource shape worth trying for an action (undefined included). */
function resourcesFor(action: Action): unknown[] {
  const out: unknown[] = [undefined];
  const jobs = SITUATIONS.flatMap((s) => CATEGORIES.map((c) => job(s, c)));
  const paused = jobs.map((j) => ({ ...j, isPaused: true }));
  if (isJobAction(action)) return [...out, ...jobs, ...paused];
  if (action.startsWith("link.")) {
    for (const j of jobs) for (const kind of LINK_KINDS) for (const by of [ME, STRANGER]) out.push({ job: j, kind, addedByUserId: by });
    return out;
  }
  if (action.startsWith("note.")) {
    for (const j of jobs) for (const kind of NOTE_KINDS) for (const by of [ME, STRANGER]) out.push({ job: j, kind, authorUserId: by });
    return out;
  }
  if (action === "comment.edit" || action === "comment.delete") {
    for (const j of jobs)
      for (const by of [ME, STRANGER])
        for (const createdAt of ["2026-10-09T02:50:00.000Z", "2026-10-09T01:00:00.000Z"]) out.push({ job: j, authorUserId: by, createdAt, deletedAt: null });
    return out;
  }
  if (action.startsWith("client.") || action.startsWith("project.")) {
    for (const by of [ME, STRANGER]) for (const v of [true, false]) out.push({ organisationId: ORG, createdByUserId: by, hasVisibleJob: v });
    return out;
  }
  if (action.startsWith("user.")) {
    for (const id of [ME, STRANGER])
      for (const role of ROLES)
        for (const isActive of [true, false])
          for (const nextRole of [undefined, ...ROLES]) out.push({ id, role, isActive, organisationId: ORG, nextRole });
    return out;
  }
  if (["notification.read", "notification.prefs", "saved_view.manage", "dashboard.customise"].includes(action)) {
    out.push({ userId: ME }, { userId: STRANGER });
  }
  return out;
}

function ctxVariants(role: Role): AuthContext[] {
  return [
    ctx(role),
    ctx(role, {}, ALL_FLAGS),
    ctx(role, { canViewAnalytics: true, canViewTeamWorkloads: true }, ALL_FLAGS),
    ctx(role, {}, { timeTrackingEnabled: false }),
  ];
}

const check = <A extends Action>(c: AuthContext, a: A, r: unknown) => can(c, a, r as ResourceOf<A>);

/* ------------------------------------------------------------------ */
/*  Structural agreement with PERMISSIONS                              */
/* ------------------------------------------------------------------ */

describe("POLICY ↔ PERMISSIONS", () => {
  it("covers every action exactly", () => {
    expect(Object.keys(POLICY).sort()).toEqual([...ACTIONS].sort());
  });

  it("scope notes are declared for exactly the roles PERMISSIONS lists", () => {
    for (const action of ACTIONS) {
      const rule: { scope: Partial<Record<Role, string>> } = POLICY[action];
      expect(Object.keys(rule.scope).sort(), action).toEqual([...PERMISSIONS[action]].sort());
    }
  });

  it("the set of roles for which can() is ever true equals PERMISSIONS[action]", () => {
    for (const action of ACTIONS) {
      const resources = resourcesFor(action);
      const ever = ROLES.filter((role) => ctxVariants(role).some((c) => resources.some((r) => check(c, action, r))));
      expect(ever.sort(), action).toEqual([...PERMISSIONS[action]].sort());
    }
  });

  it("roleCanEver mirrors PERMISSIONS", () => {
    for (const action of ACTIONS) for (const role of ROLES) expect(roleCanEver(role, action)).toBe((PERMISSIONS[action] as readonly Role[]).includes(role));
  });
});

/* ------------------------------------------------------------------ */
/*  Hard rules                                                         */
/* ------------------------------------------------------------------ */

describe("hard rules", () => {
  it("inactive actors are denied everything", () => {
    for (const action of ACTIONS)
      for (const role of ROLES) {
        const c = ctx(role, { isActive: false }, ALL_FLAGS);
        for (const r of resourcesFor(action)) expect(check(c, action, r), `${role} ${action}`).toBe(false);
      }
  });

  it("resources from another organisation are denied for every role and action", () => {
    for (const action of ACTIONS)
      for (const role of ROLES) {
        const c = ctx(role, { canViewAnalytics: true }, ALL_FLAGS);
        const foreign = resourcesFor(action).filter((r) => {
          if (typeof r !== "object" || r === null) return false;
          const o = r as { organisationId?: string; job?: { organisationId: string } };
          return o.organisationId === "org-2" || o.job?.organisationId === "org-2";
        });
        for (const r of foreign) expect(check(c, action, r), `${role} ${action}`).toBe(false);
      }
    expect(can(ctx("owner"), "user.edit", { id: STRANGER, role: "editor", isActive: true, organisationId: "org-2" })).toBe(false);
  });

  it("system context may only perform the automation allowlist", () => {
    const sys = ctx("owner", { isSystem: true, userId: null });
    for (const action of ACTIONS) {
      const r = isJobAction(action) ? job("other") : action === "note.add" ? { job: job("other"), kind: "internal" } : undefined;
      expect(check(sys, action, r), action).toBe(SYSTEM_ACTION_ALLOWLIST.has(action));
    }
    expect([...SYSTEM_ACTION_ALLOWLIST].sort()).toEqual(["job.assign_editor", "job.set_priority", "job.transition", "job.view", "note.add"]);
    expect(can(sys, "job.transition", job("otherOrg"))).toBe(false);
  });

  it("a non-system context without a user id is denied", () => {
    expect(can(ctx("owner", { userId: null }), "job.view", job("other"))).toBe(false);
  });

  it("assertCan throws ForbiddenError carrying the action", () => {
    expect(() => assertCan(ctx("editor"), "settings.manage")).toThrow(ForbiddenError);
    try {
      assertCan(ctx("editor"), "job.approve", job("assigned"));
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).action).toBe("job.approve");
      expect((e as ForbiddenError).status).toBe(403);
    }
    expect(() => assertCan(ctx("owner"), "settings.manage")).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  Scope table                                                        */
/* ------------------------------------------------------------------ */

type Row = [Action, Role, Situation, boolean, Partial<ContextSettings>?, StatusCategory?];

const SCOPE_TABLE: Row[] = [
  // job.view — photographer: own ∨ team ∨ all
  ["job.view", "photographer", "own", true],
  ["job.view", "photographer", "createdBy", true],
  ["job.view", "photographer", "team", false],
  ["job.view", "photographer", "team", true, { photographersSeeTeamJobs: true }],
  ["job.view", "photographer", "other", false],
  ["job.view", "photographer", "other", true, { photographersSeeAllJobs: true }],
  ["job.view", "photographer", "otherOrg", false, { photographersSeeAllJobs: true }],
  // job.view — editor: assigned ∨ past ∨ team
  ["job.view", "editor", "assigned", true],
  ["job.view", "editor", "past", true],
  ["job.view", "editor", "own", false],
  ["job.view", "editor", "team", false],
  ["job.view", "editor", "team", true, { editorsSeeTeamJobs: true }],
  ["job.view", "editor", "other", false],
  ["job.view", "manager", "other", true],
  ["job.view", "owner", "otherOrg", false],
  ["job.view_history", "editor", "past", true],
  // edit fields / deadlines
  ["job.edit_fields", "photographer", "own", true],
  ["job.edit_fields", "photographer", "team", false, { photographersSeeTeamJobs: true }],
  ["job.edit_fields", "editor", "assigned", false],
  ["job.edit_completion_percent", "editor", "assigned", true],
  ["job.edit_completion_percent", "editor", "past", false],
  ["job.set_due_date", "photographer", "createdBy", true],
  ["job.set_due_date", "editor", "assigned", false],
  ["job.set_priority", "manager", "other", true],
  // assignment
  ["job.assign_photographer", "photographer", "createdBy", true],
  ["job.assign_photographer", "photographer", "own", false],
  ["job.assign_editor", "photographer", "own", true],
  ["job.assign_editor", "photographer", "other", false],
  ["job.assign_editor", "editor", "assigned", false],
  // transitions
  ["job.transition", "photographer", "own", true],
  ["job.transition", "photographer", "team", false, { photographersSeeTeamJobs: true }],
  ["job.transition", "editor", "assigned", true],
  ["job.transition", "editor", "past", false],
  ["job.transition_override", "manager", "other", true],
  ["job.transition_override", "photographer", "own", false],
  ["job.accept", "editor", "assigned", true, {}, "assigned"],
  ["job.accept", "manager", "other", true, {}, "assigned"],
  ["job.accept", "photographer", "own", false, {}, "assigned"],
  ["job.decline", "editor", "assigned", true, {}, "assigned"],
  ["job.decline", "editor", "assigned", false, {}, "in_progress"],
  ["job.decline", "owner", "other", false, {}, "assigned"],
  ["job.pause", "editor", "assigned", true, {}, "in_progress"],
  ["job.pause", "editor", "assigned", false, {}, "submitted"],
  ["job.pause", "manager", "other", true, {}, "revision"],
  ["job.approve", "photographer", "own", true, {}, "submitted"],
  ["job.approve", "editor", "assigned", false, {}, "submitted"],
  ["job.cancel", "photographer", "own", true, {}, "in_progress"],
  ["job.cancel", "photographer", "own", false, {}, "completed"],
  ["job.cancel", "owner", "other", false, {}, "cancelled"],
  ["job.cancel", "owner", "other", true, {}, "approved"],
  ["job.reopen", "photographer", "own", true, {}, "completed"],
  ["job.migrate_workflow", "manager", "other", true],
  ["revision.resolve", "editor", "assigned", true, {}, "revision"],
  ["revision.resolve", "photographer", "own", false, {}, "revision"],
  ["revision.request", "photographer", "own", true, {}, "submitted"],
  // comments
  ["comment.add", "photographer", "team", true, { photographersSeeTeamJobs: true }],
  ["comment.add", "editor", "assigned", true],
  ["comment.add", "editor", "past", false],
  ["comment.add", "editor", "team", false, { editorsSeeTeamJobs: true }],
  // timer
  ["timer.use", "editor", "assigned", true, {}, "in_progress"],
  ["timer.use", "editor", "assigned", false, {}, "submitted"],
  ["timer.use", "editor", "assigned", false, { timeTrackingEnabled: false }, "in_progress"],
  ["timer.use", "owner", "assigned", true],
  ["timer.use", "owner", "other", false],
  ["timer.use", "photographer", "own", true],
  ["timer.view_others", "photographer", "own", true],
  ["timer.view_others", "photographer", "other", false],
];

describe("scope table (role × situation)", () => {
  it.each(SCOPE_TABLE)("%s · %s · %s → %s", (action, role, sit, expected, settings = {}, category = "in_progress") => {
    expect(check(ctx(role, {}, settings), action, job(sit, category))).toBe(expected);
  });

  it("owners and managers act on every in-org job for job-scoped any-actions", () => {
    for (const role of ["owner", "manager"] as const)
      for (const sit of ["own", "assigned", "past", "team", "other"] as const) {
        expect(can(ctx(role), "job.edit_fields", job(sit))).toBe(true);
        expect(can(ctx(role), "job.approve", job(sit, "submitted"))).toBe(true);
      }
  });
});

describe("links, notes, comments", () => {
  it("link.add: editor only EDITOR_LINK_KINDS on assigned jobs; photographer any kind on own", () => {
    expect(can(ctx("editor"), "link.add", { job: job("assigned"), kind: "finished_files" })).toBe(true);
    expect(can(ctx("editor"), "link.add", { job: job("assigned"), kind: "raw_files" })).toBe(false);
    expect(can(ctx("editor"), "link.add", { job: job("past"), kind: "finished_files" })).toBe(false);
    expect(can(ctx("photographer"), "link.add", { job: job("own"), kind: "raw_files" })).toBe(true);
    expect(can(ctx("photographer"), "link.add", { job: job("other"), kind: "raw_files" })).toBe(false);
  });

  it("link.replace/remove: editors only their own links on assigned jobs", () => {
    expect(can(ctx("editor"), "link.replace", { job: job("assigned"), addedByUserId: ME })).toBe(true);
    expect(can(ctx("editor"), "link.replace", { job: job("assigned"), addedByUserId: STRANGER })).toBe(false);
    expect(can(ctx("photographer"), "link.remove", { job: job("own"), addedByUserId: STRANGER })).toBe(true);
    expect(can(ctx("manager"), "link.remove", { job: job("other"), addedByUserId: STRANGER })).toBe(true);
  });

  it("note.read: internal notes hidden from editors and from photographers on others' jobs", () => {
    expect(can(ctx("editor"), "note.read", { job: job("assigned"), kind: "internal" })).toBe(false);
    expect(can(ctx("editor"), "note.read", { job: job("assigned"), kind: "editor" })).toBe(true);
    expect(can(ctx("editor"), "note.read", { job: job("other"), kind: "editor" })).toBe(false);
    expect(can(ctx("photographer"), "note.read", { job: job("own"), kind: "internal" })).toBe(true);
    expect(can(ctx("photographer", {}, { photographersSeeAllJobs: true }), "note.read", { job: job("other"), kind: "internal" })).toBe(false);
    expect(can(ctx("photographer", {}, { photographersSeeAllJobs: true }), "note.read", { job: job("other"), kind: "client" })).toBe(true);
  });

  it("note.add/edit kinds per role", () => {
    expect(can(ctx("photographer"), "note.add", { job: job("own"), kind: "client" })).toBe(true);
    expect(can(ctx("photographer"), "note.add", { job: job("own"), kind: "internal" })).toBe(false);
    expect(can(ctx("photographer"), "note.add", { job: job("own"), kind: "editor" })).toBe(false);
    expect(can(ctx("editor"), "note.add", { job: job("assigned"), kind: "editor" })).toBe(true);
    expect(can(ctx("editor"), "note.add", { job: job("assigned"), kind: "photographer" })).toBe(false);
    expect(can(ctx("editor"), "note.edit", { job: job("assigned"), kind: "editor", authorUserId: ME })).toBe(true);
    expect(can(ctx("editor"), "note.edit", { job: job("assigned"), kind: "editor", authorUserId: STRANGER })).toBe(false);
    expect(can(ctx("manager"), "note.add", { job: job("other"), kind: "internal" })).toBe(true);
  });

  it("comment.edit: own comment within the 15-minute window only", () => {
    const recent = { job: job("assigned"), authorUserId: ME, createdAt: "2026-10-09T02:45:00.000Z" };
    const edge = { ...recent, createdAt: "2026-10-09T02:45:00.000Z" }; // exactly 15 min
    const old = { ...recent, createdAt: "2026-10-09T02:44:59.999Z" };
    expect(can(ctx("editor"), "comment.edit", recent)).toBe(true);
    expect(can(ctx("editor"), "comment.edit", edge)).toBe(true);
    expect(can(ctx("editor"), "comment.edit", old)).toBe(false);
    expect(can(ctx("owner"), "comment.edit", { ...recent, authorUserId: STRANGER })).toBe(false);
    expect(can(ctx("editor"), "comment.edit", { ...recent, deletedAt: NOW })).toBe(false);
  });

  it("comment.delete: management any, others own", () => {
    const c = { job: job("assigned"), authorUserId: STRANGER, createdAt: NOW };
    expect(can(ctx("manager"), "comment.delete", c)).toBe(true);
    expect(can(ctx("editor"), "comment.delete", c)).toBe(false);
    expect(can(ctx("editor"), "comment.delete", { ...c, authorUserId: ME })).toBe(true);
  });
});

describe("users, org resources, self, flags", () => {
  const target = (role: Role, over: Partial<{ id: string; isActive: boolean; nextRole: Role }> = {}) => ({
    id: STRANGER,
    role,
    isActive: true,
    organisationId: ORG,
    ...over,
  });

  it("managers administer photographers/editors only; role changes P ⇄ E", () => {
    expect(can(ctx("manager"), "user.deactivate", target("editor"))).toBe(true);
    expect(can(ctx("manager"), "user.deactivate", target("manager"))).toBe(false);
    expect(can(ctx("manager"), "user.change_role", target("editor", { nextRole: "photographer" }))).toBe(true);
    expect(can(ctx("manager"), "user.change_role", target("editor", { nextRole: "manager" }))).toBe(false);
    expect(can(ctx("manager"), "user.invite", target("photographer"))).toBe(true);
    expect(can(ctx("manager"), "user.invite", target("owner"))).toBe(false);
    expect(can(ctx("owner"), "user.change_role", target("manager", { nextRole: "owner" }))).toBe(true);
  });

  it("owner cannot deactivate self; anonymise only deactivated users", () => {
    expect(can(ctx("owner"), "user.deactivate", target("owner", { id: ME }))).toBe(false);
    expect(can(ctx("owner"), "user.anonymise", target("editor"))).toBe(false);
    expect(can(ctx("owner"), "user.anonymise", target("editor", { isActive: false }))).toBe(true);
    expect(can(ctx("manager"), "user.anonymise", target("editor", { isActive: false }))).toBe(false);
  });

  it("photographers/editors edit only themselves", () => {
    expect(can(ctx("editor"), "user.edit", target("editor", { id: ME }))).toBe(true);
    expect(can(ctx("editor"), "user.edit", target("editor"))).toBe(false);
    expect(can(ctx("photographer"), "user.reset_password", target("photographer", { id: ME }))).toBe(true);
  });

  it("clients/projects", () => {
    expect(can(ctx("photographer"), "client.edit", { organisationId: ORG, createdByUserId: ME })).toBe(true);
    expect(can(ctx("photographer"), "client.edit", { organisationId: ORG, createdByUserId: STRANGER })).toBe(false);
    expect(can(ctx("editor"), "project.view", { organisationId: ORG, hasVisibleJob: false })).toBe(false);
    expect(can(ctx("editor"), "project.view", { organisationId: ORG, hasVisibleJob: true })).toBe(true);
    expect(can(ctx("editor"), "client.create")).toBe(false);
  });

  it("self-scoped resources", () => {
    expect(can(ctx("editor"), "notification.read", { userId: ME })).toBe(true);
    expect(can(ctx("owner"), "notification.read", { userId: STRANGER })).toBe(false);
  });

  it("analytics and workload flags", () => {
    expect(can(ctx("photographer"), "analytics.view")).toBe(false);
    expect(can(ctx("photographer", { canViewAnalytics: true }), "analytics.view")).toBe(true);
    expect(can(ctx("photographer", { canViewAnalytics: true }), "export.csv")).toBe(true);
    expect(can(ctx("editor", { canViewAnalytics: true }), "analytics.view")).toBe(false);
    expect(can(ctx("photographer", { canViewTeamWorkloads: true }), "workloads.view_team")).toBe(true);
    expect(can(ctx("editor"), "workloads.view_team")).toBe(false);
    expect(can(ctx("editor", {}, { editorsSeeTeamWorkloads: true }), "workloads.view_team")).toBe(true);
    expect(can(ctx("editor"), "workloads.view_self")).toBe(true);
    expect(can(ctx("photographer", { canViewAnalytics: true }), "performance.view")).toBe(false);
  });

  it("management events visible to owner/manager only", () => {
    expect(canSeeManagementEvents(ctx("owner"))).toBe(true);
    expect(canSeeManagementEvents(ctx("manager"))).toBe(true);
    expect(canSeeManagementEvents(ctx("photographer", { canViewAnalytics: true }))).toBe(false);
    expect(canSeeManagementEvents(ctx("editor"))).toBe(false);
  });

  it("owner-only actions", () => {
    for (const a of ["settings.manage", "workflow.manage", "system.integrity", "user.anonymise"] as const) {
      expect(roleCanEver("owner", a)).toBe(true);
      expect(roleCanEver("manager", a)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  visibleJobsWhere                                                   */
/* ------------------------------------------------------------------ */

describe("visibleJobsWhere", () => {
  const dialect = new SQLiteSyncDialect();
  const render = (c: AuthContext) => dialect.sqlToQuery(visibleJobsWhere(c));

  const FLAG_COMBOS: Partial<ContextSettings>[] = [
    {},
    { photographersSeeTeamJobs: true },
    { photographersSeeAllJobs: true },
    { editorsSeeTeamJobs: true },
    ALL_FLAGS,
  ];

  it.each(ROLES.flatMap((role) => FLAG_COMBOS.map((flags) => [role, flags] as const)))("compiles for %s with %o", (role, flags) => {
    const q = render(ctx(role, {}, flags));
    expect(q.sql).toContain('"organisation_id"');
    expect(q.params).toContain(ORG);
  });

  it("owner/manager/system: organisation filter only", () => {
    for (const c of [ctx("owner"), ctx("manager"), ctx("owner", { isSystem: true, userId: null })]) {
      const q = render(c);
      expect(q.sql).toBe('"jobs"."organisation_id" = ?');
      expect(q.params).toEqual([ORG]);
    }
  });

  it("photographer: own/created, team only with the flag, all with the all-jobs flag", () => {
    const plain = render(ctx("photographer"));
    expect(plain.sql).toContain('"photographer_id"');
    expect(plain.sql).toContain('"created_by_user_id"');
    expect(plain.params).not.toContain(TEAMMATE);
    const team = render(ctx("photographer", {}, { photographersSeeTeamJobs: true }));
    expect(team.sql).toContain('"editor_id" in');
    expect(team.params).toContain(TEAMMATE);
    const all = render(ctx("photographer", {}, { photographersSeeAllJobs: true }));
    expect(all.sql).toBe('"jobs"."organisation_id" = ?');
  });

  it("editor: assigned or past (EXISTS on job_assignments), team only with the flag", () => {
    const plain = render(ctx("editor"));
    expect(plain.sql).toContain('"editor_id" = ?');
    expect(plain.sql).toMatch(/exists \(select 1 from "job_assignments"/);
    expect(plain.sql).toContain('"job_assignments"."user_id"');
    expect(plain.sql).toContain("'editor'");
    expect(plain.params).toContain(ME);
    expect(plain.params).not.toContain(TEAMMATE);
    expect(render(ctx("editor", {}, { editorsSeeTeamJobs: true })).params).toContain(TEAMMATE);
    // photographer flag does not leak into editors
    expect(render(ctx("editor", {}, { photographersSeeAllJobs: true })).sql).toMatch(/exists/);
  });

  it("team flag with no teammates adds no team clause", () => {
    const q = render(ctx("editor", { teamUserIds: new Set() }, { editorsSeeTeamJobs: true }));
    expect(q.sql).not.toContain(" in (");
  });

  it("inactive actor / missing user id → matches nothing", () => {
    expect(render(ctx("owner", { isActive: false })).sql).toContain("1 = 0");
    expect(render(ctx("editor", { userId: null })).sql).toContain("1 = 0");
  });
});

/* ------------------------------------------------------------------ */
/*  Roles page matrix                                                  */
/* ------------------------------------------------------------------ */

describe("permissionMatrix", () => {
  const matrix = permissionMatrix();

  it("has one row per action with cells derived from PERMISSIONS", () => {
    expect(matrix.map((r) => r.action)).toEqual([...ACTIONS]);
    for (const row of matrix) {
      expect(row.label.length).toBeGreaterThan(0);
      for (const role of ROLES) {
        expect(row.cells[role].allowed).toBe(roleCanEver(role, row.action));
        if (!row.cells[role].allowed) expect(row.cells[role].scope).toBe("never");
      }
    }
  });

  it("renders scope notes", () => {
    const byAction = new Map(matrix.map((r) => [r.action, r]));
    expect(byAction.get("job.edit_fields")?.cells.photographer).toEqual({ allowed: true, scope: "own jobs" });
    expect(byAction.get("job.edit_fields")?.cells.editor).toEqual({ allowed: false, scope: "never" });
    expect(byAction.get("settings.manage")?.cells.owner).toEqual({ allowed: true, scope: "any" });
    expect(byAction.get("job.decline")?.cells.editor.allowed).toBe(true);
    expect(byAction.get("job.decline")?.cells.owner.allowed).toBe(false);
  });
});
