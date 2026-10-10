import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/types";
import { navGatesFor } from "@/server/nav-gates";
import { NO_NAV_GATES, navigationFor, portalNavigation, resolveRouteTitle, visibleNavIds, type NavGates } from "./nav";

/* ------------------------------------------------------------------ */
/*  Personas (docs/ROLES.md §10): admin · member at invite defaults ·  */
/*  member with every switch (photographer01) · editor · editor02      */
/* ------------------------------------------------------------------ */

function ctx(over: Partial<AuthContext>): AuthContext {
  return {
    userId: "u-1",
    organisationId: "org-1",
    role: "photographer",
    isAdmin: false,
    isPrimaryOwner: false,
    isActive: true,
    canCreateJobs: false,
    canViewAllJobs: false,
    canAssignEditors: false,
    canReviewSubmissions: false,
    canViewTeamWorkloads: false,
    canViewAnalytics: false,
    canViewTeamJobs: false,
    clientId: null,
    clientFeedbackEnabled: false,
    teamUserIds: new Set(),
    settings: { timezone: "Australia/Sydney", timeTrackingEnabled: true, automationsEnabled: true },
    isSystem: false,
    now: () => "2026-10-09T03:00:00.000Z",
    requestId: "req",
    ...over,
  };
}

const ALL_MEMBER = {
  canCreateJobs: true,
  canViewAllJobs: true,
  canAssignEditors: true,
  canReviewSubmissions: true,
  canViewTeamWorkloads: true,
  canViewAnalytics: true,
};

const PERSONAS = {
  admin: ctx({ isAdmin: true, isPrimaryOwner: true, ...ALL_MEMBER }),
  memberDefault: ctx({ canCreateJobs: true, canAssignEditors: true }),
  memberAll: ctx({ ...ALL_MEMBER }),
  editor: ctx({ role: "editor", canCreateJobs: true }),
  editorTeam: ctx({ role: "editor", canCreateJobs: true, canViewTeamJobs: true }),
} as const;
type PersonaKey = keyof typeof PERSONAS;
const gatesOf = (k: PersonaKey): NavGates => navGatesFor(PERSONAS[k]);

const EVERYONE: PersonaKey[] = ["admin", "memberDefault", "memberAll", "editor", "editorTeam"];

/** §10 exact matrix: item id → personas that see it. */
const NAV_MATRIX: Record<string, PersonaKey[]> = {
  dashboard: EVERYONE,
  "all-work": EVERYONE,
  "my-work": EVERYONE,
  kanban: EVERYONE,
  calendar: EVERYONE,
  timeline: EVERYONE,
  "team-work": ["admin", "memberAll", "editorTeam"],
  jobs: EVERYONE,
  projects: EVERYONE,
  clients: EVERYONE,
  photographers: ["admin", "memberDefault", "memberAll"],
  editors: ["admin", "memberDefault", "memberAll"],
  workloads: ["admin", "memberAll"],
  performance: ["admin", "memberAll"],
  analytics: ["admin", "memberAll"],
  bottlenecks: ["admin", "memberAll"],
  reports: ["admin", "memberAll"],
  "activity-log": EVERYONE,
  organisation: ["admin"],
  users: ["admin"],
  roles: ["admin"],
  teams: ["admin"],
  workflows: ["admin"],
  "job-types": ["admin"],
  automations: ["admin"],
  notifications: EVERYONE,
};

const QUICK_MATRIX: Record<string, PersonaKey[]> = {
  "new-job": EVERYONE,
  "new-project": ["admin", "memberDefault", "memberAll"],
  "new-client": ["admin", "memberDefault", "memberAll"],
  "invite-user": ["admin"],
  "open-settings": ["admin"],
};

describe("navigation per persona (docs/ROLES.md §10)", () => {
  it.each(EVERYONE)("%s sees exactly the §10 items, quick actions and tabs", (persona) => {
    const { nav, quick, tabs } = visibleNavIds(gatesOf(persona));
    expect(nav.sort()).toEqual(Object.keys(NAV_MATRIX).filter((id) => NAV_MATRIX[id].includes(persona)).sort());
    expect(quick.sort()).toEqual(Object.keys(QUICK_MATRIX).filter((id) => QUICK_MATRIX[id].includes(persona)).sort());
    expect(tabs).toEqual(["dashboard", "my-work", "kanban", "search", "more"]);
  });

  it("every nav item and quick action is covered by the matrix", () => {
    const all = visibleNavIds({ admin: true, createJobs: true, createClients: true, teamWork: true, directory: true, teamWorkloads: true, analytics: true });
    expect(all.nav.sort()).toEqual(Object.keys(NAV_MATRIX).sort());
    expect(all.quick.sort()).toEqual(Object.keys(QUICK_MATRIX).sort());
  });

  it("members / editors with Create jobs off lose New job (members also New project / New client)", () => {
    expect(visibleNavIds(navGatesFor(ctx({}))).quick).toEqual([]);
    expect(visibleNavIds(navGatesFor(ctx({ role: "editor" }))).quick).toEqual([]);
  });

  it("gates snapshot for the five staff personas", () => {
    expect(Object.fromEntries(EVERYONE.map((p) => [p, gatesOf(p)]))).toMatchSnapshot();
  });

  it("clients, inactive users and the system context open no gate", () => {
    expect(navGatesFor(ctx({ role: "client", clientId: "c-1" }))).toEqual(NO_NAV_GATES);
    expect(navGatesFor(ctx({ isAdmin: true, ...ALL_MEMBER, isActive: false }))).toEqual(NO_NAV_GATES);
    expect(navGatesFor(ctx({ isSystem: true, userId: null })).admin).toBe(false);
  });

  it("the client portal has its own navigation", () => {
    expect(portalNavigation.map((i) => i.href)).toEqual(["/portal", "/portal/notifications", "/portal/account"]);
  });
});

describe("resolveRouteTitle (topbar title)", () => {
  const admin = navigationFor(gatesOf("admin"));
  const editor = navigationFor(gatesOf("editor"));

  it("uses the nav item + group for sidebar routes", () => {
    expect(resolveRouteTitle("/dashboard", admin)?.title).toBe("Dashboard");
    expect(resolveRouteTitle("/workspace/kanban", admin)?.title).toBe("Kanban");
    expect(resolveRouteTitle("/team/workloads", admin)).toMatchObject({ eyebrow: "Team" });
  });

  it("names the personal pages reached from the bell, search and user menu", () => {
    for (const groups of [admin, editor]) {
      expect(resolveRouteTitle("/notifications", groups)?.title).toBe("Notifications");
      expect(resolveRouteTitle("/search", groups)?.title).toBe("Search");
      expect(resolveRouteTitle("/settings/profile", groups)?.title).toBe("Your profile");
      expect(resolveRouteTitle("/settings/appearance", groups)?.title).toBe("Appearance");
      expect(resolveRouteTitle("/help", groups)?.title).toBe("Help & shortcuts");
    }
  });

  it("falls back to the user-menu label when no visible nav item matches", () => {
    expect(resolveRouteTitle("/settings/notifications", [])?.title).toBe("Notification settings");
    expect(resolveRouteTitle("/settings/notifications", editor)?.title).toBeTruthy();
  });

  it("titles the dynamic team member page", () => {
    expect(resolveRouteTitle("/team/users/abc123", admin)).toEqual({ title: "Team member", eyebrow: "Team" });
    expect(resolveRouteTitle("/team/users/abc123/history", admin)?.title).toBe("Team member");
  });

  it("does not over-match look-alike paths", () => {
    expect(resolveRouteTitle("/searchable", editor)).toBeNull();
    expect(resolveRouteTitle("/team/users", editor)).toBeNull();
  });
});
