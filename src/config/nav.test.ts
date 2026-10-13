import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/types";
import { navGatesFor } from "@/server/nav-gates";
import {
  NO_NAV_GATES,
  advancedFeatureForApi,
  advancedFeatureForRoute,
  isAdvancedRoute,
  isNavItemActive,
  mobileTabsFor,
  navigationFor,
  portalNavigation,
  resolveRouteTitle,
  visibleNavIds,
  type NavGates,
} from "./nav";

/* ------------------------------------------------------------------ */
/*  Personas (docs/SIMPLIFICATION-PLAN.md §3): owner · co-owner ·      */
/*  extra photographer ("Only their own shoots") · editor              */
/* ------------------------------------------------------------------ */

const SETTINGS = { timezone: "Australia/Sydney", timeTrackingEnabled: false, automationsEnabled: true, advancedToolsEnabled: false };

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
    settings: SETTINGS,
    isSystem: false,
    now: () => "2026-10-13T03:00:00.000Z",
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
const OWN_SHOOTS = { canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true };
const ADVANCED_ON = { settings: { ...SETTINGS, advancedToolsEnabled: true } };

const PERSONAS = {
  owner: ctx({ isAdmin: true, isPrimaryOwner: true, ...ALL_MEMBER }),
  coOwner: ctx({ isAdmin: true, ...ALL_MEMBER }),
  ownerAdvanced: ctx({ isAdmin: true, isPrimaryOwner: true, ...ALL_MEMBER, ...ADVANCED_ON }),
  photographer: ctx({ ...OWN_SHOOTS }),
  photographerAdvanced: ctx({ ...OWN_SHOOTS, ...ADVANCED_ON }),
  editor: ctx({ role: "editor" }),
  editorCreates: ctx({ role: "editor", canCreateJobs: true }),
  editorAdvanced: ctx({ role: "editor", ...ADVANCED_ON }),
} as const;
type PersonaKey = keyof typeof PERSONAS;
const gatesOf = (k: PersonaKey): NavGates => navGatesFor(PERSONAS[k]);
const ALL: PersonaKey[] = Object.keys(PERSONAS) as PersonaKey[];
const ADMINS: PersonaKey[] = ["owner", "coOwner", "ownerAdvanced"];
const PHOTOGRAPHERS: PersonaKey[] = [...ADMINS, "photographer", "photographerAdvanced"];
const EDITORS: PersonaKey[] = ["editor", "editorCreates", "editorAdvanced"];

/** Plan §3: item id → personas that see it. */
const NAV_MATRIX: Record<string, PersonaKey[]> = {
  home: PHOTOGRAPHERS,
  jobs: PHOTOGRAPHERS,
  clients: PHOTOGRAPHERS,
  editors: ADMINS,
  settings: ADMINS,
  "my-jobs": EDITORS,
  calendar: EDITORS,
  // the Advanced group: the owner's, and only while the studio's switch is on
  kanban: ["ownerAdvanced"],
  timeline: ["ownerAdvanced"],
  analytics: ["ownerAdvanced"],
  automations: ["ownerAdvanced"],
  workflows: ["ownerAdvanced"],
};

const QUICK_MATRIX: Record<string, PersonaKey[]> = {
  "new-job": [...PHOTOGRAPHERS, "editorCreates"],
  "new-client": PHOTOGRAPHERS,
  "invite-user": ADMINS,
  "open-settings": ADMINS,
  "new-project": ["ownerAdvanced"],
};

/** Plan §3 phone tabs per persona, in order. */
const TABS: Record<PersonaKey, string[]> = {
  owner: ["home", "jobs", "new-job", "editors", "more"],
  coOwner: ["home", "jobs", "new-job", "editors", "more"],
  ownerAdvanced: ["home", "jobs", "new-job", "editors", "more"],
  photographer: ["home", "jobs", "new-job", "more"],
  photographerAdvanced: ["home", "jobs", "new-job", "more"],
  editor: ["my-jobs", "calendar", "search", "me"],
  editorCreates: ["my-jobs", "calendar", "search", "me"],
  editorAdvanced: ["my-jobs", "calendar", "search", "me"],
};

describe("navigation per persona (SIMPLIFICATION-PLAN §3)", () => {
  it.each(ALL)("%s sees exactly the plan's items, quick actions and tabs", (persona) => {
    const { nav, quick, tabs } = visibleNavIds(gatesOf(persona));
    expect(nav.sort()).toEqual(Object.keys(NAV_MATRIX).filter((id) => NAV_MATRIX[id].includes(persona)).sort());
    expect(quick.sort()).toEqual(Object.keys(QUICK_MATRIX).filter((id) => QUICK_MATRIX[id].includes(persona)).sort());
    expect(tabs).toEqual(TABS[persona]);
  });

  it("the owner's menu has five items; the Advanced group appears only when the studio's switch is on", () => {
    expect(navigationFor(gatesOf("owner")).map((g) => g.items.map((i) => i.label))).toEqual([["Home", "Jobs", "Editors", "Clients", "Settings"]]);
    expect(navigationFor(gatesOf("ownerAdvanced")).map((g) => g.label ?? "main")).toEqual(["main", "Advanced"]);
    expect(navigationFor(gatesOf("ownerAdvanced"))[1].items.map((i) => i.label)).toEqual(["Board", "Timeline", "Reports & stats", "Automations", "Workflows"]);
    // an extra photographer never gets the Advanced group, switch or not
    expect(navigationFor(gatesOf("photographerAdvanced")).map((g) => g.items.map((i) => i.label))).toEqual([["Home", "Jobs", "Clients"]]);
    expect(navigationFor(gatesOf("editorAdvanced")).map((g) => g.items.map((i) => i.label))).toEqual([["My jobs", "Calendar"]]);
  });

  it("hrefs are the plan's addresses", () => {
    const hrefs = Object.fromEntries(navigationFor(gatesOf("ownerAdvanced")).flatMap((g) => g.items.map((i) => [i.id, i.href])));
    expect(hrefs).toEqual({
      home: "/home",
      jobs: "/jobs",
      editors: "/editors",
      clients: "/clients",
      settings: "/settings/studio",
      kanban: "/workspace/kanban",
      timeline: "/workspace/timeline",
      analytics: "/insights/analytics",
      automations: "/settings/automations",
      workflows: "/settings/workflows",
    });
    expect(Object.fromEntries(navigationFor(gatesOf("editor")).flatMap((g) => g.items.map((i) => [i.id, i.href])))).toEqual({ "my-jobs": "/my-jobs", calendar: "/calendar" });
    expect(mobileTabsFor(gatesOf("editor")).map((t) => t.href ?? t.action)).toEqual(["/my-jobs", "/calendar", "search", "/settings/account"]);
    expect(mobileTabsFor(gatesOf("owner")).find((t) => t.id === "home")?.badge).toBe("to_check");
    expect(mobileTabsFor(gatesOf("owner")).find((t) => t.id === "new-job")?.primary).toBe(true);
  });

  it("every nav item, quick action and tab is covered by the matrices", () => {
    const all = visibleNavIds(Object.fromEntries(Object.keys(NO_NAV_GATES).map((k) => [k, true])) as NavGates);
    expect(all.nav.sort()).toEqual(Object.keys(NAV_MATRIX).sort());
    expect(all.quick.sort()).toEqual(Object.keys(QUICK_MATRIX).sort());
    expect(all.tabs.sort()).toEqual([...new Set(Object.values(TABS).flat())].sort());
  });

  it("photographers / editors with Create jobs off lose New job (and the (+) tab)", () => {
    expect(visibleNavIds(navGatesFor(ctx({}))).quick).toEqual([]);
    expect(visibleNavIds(navGatesFor(ctx({}))).tabs).toEqual(["home", "jobs", "more"]);
    expect(visibleNavIds(navGatesFor(ctx({ role: "editor" }))).quick).toEqual([]);
  });

  it("gates snapshot for the staff personas", () => {
    expect(Object.fromEntries(ALL.map((p) => [p, gatesOf(p)]))).toMatchSnapshot();
  });

  it("clients, inactive users and the system context open no gate", () => {
    expect(navGatesFor(ctx({ role: "client", clientId: "c-1" }))).toEqual(NO_NAV_GATES);
    expect(navGatesFor(ctx({ isAdmin: true, ...ALL_MEMBER, isActive: false }))).toEqual(NO_NAV_GATES);
    expect(navGatesFor(ctx({ isSystem: true, userId: null })).admin).toBe(false);
    expect(navGatesFor(ctx({ isSystem: true, userId: null })).photographer).toBe(false);
  });

  it("the client portal has its own navigation (unchanged)", () => {
    expect(portalNavigation.map((i) => i.href)).toEqual(["/portal", "/portal/notifications", "/portal/account"]);
  });
});

describe("advanced routes (plan §8: hidden pages are blocked on the server)", () => {
  it("maps every hidden page to its feature", () => {
    expect(advancedFeatureForRoute("/workspace/kanban")).toBe("kanban");
    expect(advancedFeatureForRoute("/workspace/timeline/anything")).toBe("timeline");
    expect(advancedFeatureForRoute("/insights/analytics")).toBe("analytics");
    expect(advancedFeatureForRoute("/insights/bottlenecks")).toBe("bottlenecks");
    expect(advancedFeatureForRoute("/insights/reports")).toBe("reports");
    expect(advancedFeatureForRoute("/team/workloads")).toBe("workloads");
    expect(advancedFeatureForRoute("/team/performance")).toBe("performance");
    expect(advancedFeatureForRoute("/settings/workflows/abc")).toBe("workflows");
    expect(advancedFeatureForRoute("/settings/automations")).toBe("automations");
    expect(advancedFeatureForRoute("/settings/teams")).toBe("teams");
    expect(advancedFeatureForRoute("/settings/roles")).toBe("permissions");
    expect(advancedFeatureForRoute("/projects/x")).toBe("projects");
    expect(advancedFeatureForRoute("/settings/appearance")).toBe("appearance_density");
    for (const simple of ["/home", "/jobs", "/jobs/abc", "/editors", "/editors/u1", "/clients", "/settings/studio", "/settings/people", "/my-jobs", "/calendar", "/projectsx"]) {
      expect(isAdvancedRoute(simple), simple).toBe(false);
    }
  });

  it("maps hidden API prefixes (internal service calls are never gated)", () => {
    expect(advancedFeatureForApi("/api/views")).toBe("saved_views");
    expect(advancedFeatureForApi("/api/dashboard/layout")).toBe("saved_views");
    expect(advancedFeatureForApi("/api/jobs/bulk/reassign")).toBe("bulk_ui");
    expect(advancedFeatureForApi("/api/workflows/x/statuses")).toBe("workflows");
    expect(advancedFeatureForApi("/api/automation-runs")).toBe("automations");
    expect(advancedFeatureForApi("/api/kanban/drop")).toBe("kanban");
    expect(advancedFeatureForApi("/api/timeline")).toBe("timeline");
    expect(advancedFeatureForApi("/api/reports/editors")).toBe("reports");
    expect(advancedFeatureForApi("/api/analytics/overview")).toBe("analytics");
    expect(advancedFeatureForApi("/api/workloads/u1")).toBe("workloads");
    expect(advancedFeatureForApi("/api/jobs")).toBeNull();
    expect(advancedFeatureForApi("/api/jobs/x/approve")).toBeNull();
    expect(advancedFeatureForApi("/api/dashboard")).toBeNull();
  });
});

describe("resolveRouteTitle (topbar title)", () => {
  const owner = navigationFor(gatesOf("ownerAdvanced"));
  const editor = navigationFor(gatesOf("editor"));

  it("uses the nav item + group for sidebar routes", () => {
    expect(resolveRouteTitle("/home", owner)?.title).toBe("Home");
    expect(resolveRouteTitle("/jobs", owner)?.title).toBe("Jobs");
    expect(resolveRouteTitle("/workspace/kanban", owner)).toMatchObject({ title: "Board", eyebrow: "Advanced" });
    expect(resolveRouteTitle("/my-jobs", editor)?.title).toBe("My jobs");
    expect(resolveRouteTitle("/settings/studio", owner)).toMatchObject({ title: "Studio", eyebrow: "Settings" });
  });

  it("names the Settings tabs, detail pages and personal pages", () => {
    expect(resolveRouteTitle("/settings/people", owner)).toMatchObject({ title: "People", eyebrow: "Settings" });
    expect(resolveRouteTitle("/settings/shoot-types", owner)?.title).toBe("Types of shoot");
    expect(resolveRouteTitle("/settings/history", owner)?.title).toBe("History");
    expect(resolveRouteTitle("/settings/automations", owner)).toMatchObject({ title: "Automations", eyebrow: "Advanced" });
    expect(resolveRouteTitle("/jobs/new", owner)).toMatchObject({ title: "New job", eyebrow: "Jobs" });
    expect(resolveRouteTitle("/jobs/abc123", editor)).toMatchObject({ title: "Job", eyebrow: "Jobs" });
    expect(resolveRouteTitle("/editors/abc123", owner)).toMatchObject({ title: "Editor", eyebrow: "Editors" });
    for (const groups of [owner, editor]) {
      expect(resolveRouteTitle("/notifications", groups)?.title).toBe("Notifications");
      expect(resolveRouteTitle("/search", groups)?.title).toBe("Search");
      expect(resolveRouteTitle("/settings/account", groups)?.title).toBe("My account");
      expect(resolveRouteTitle("/help", groups)?.title).toBe("Help");
    }
  });

  it("the Settings item is active on every settings page; look-alike paths are not over-matched", () => {
    const settings = owner[0].items.find((i) => i.id === "settings");
    expect(settings && isNavItemActive("/settings/people", settings)).toBe(true);
    expect(settings && isNavItemActive("/settingsx", settings)).toBe(false);
    expect(resolveRouteTitle("/searchable", editor)).toBeNull();
    expect(resolveRouteTitle("/team/users", editor)).toBeNull();
  });
});
