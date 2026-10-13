import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  Briefcase,
  Building2,
  CalendarDays,
  ChartNoAxesGantt,
  CircleUser,
  FolderPlus,
  Images,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  Plus,
  Search,
  Settings,
  Siren,
  SlidersHorizontal,
  SquareKanban,
  UserPlus,
  WandSparkles,
  Workflow,
  Zap,
  type LucideProps,
} from "lucide-react";
import { ADVANCED_FEATURES, ADVANCED_FEATURE_META, type AdvancedFeature } from "@/lib/constants";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Simplified navigation (docs/SIMPLIFICATION-PLAN.md §3). Items carry an optional `gate`; the (app)
 * layout computes `NavGates` server-side with `can()` (src/server/nav-gates.ts → `navGatesFor(ctx)`)
 * and the shell filters with `navigationFor(gates)` etc. No gate = every staff persona. Clients never
 * get this navigation: the portal uses `portalNavigation`.
 *
 * Who sees what (plan §3):
 *   owner / co-owner (admin)      Home · Jobs · Editors · Clients · Settings (+ Advanced group when the
 *                                 studio's Advanced tools switch is on: Board, Timeline, Reports & stats,
 *                                 Automations, Workflows)
 *   extra photographer (member)   Home · Jobs · Clients
 *   editor                        My jobs · Calendar
 */
export const NAV_GATES = [
  "admin",
  "createJobs",
  "createClients",
  "teamWork",
  "directory",
  "teamWorkloads",
  "analytics",
  "photographer",
  "editor",
  "newJob",
  "advanced",
] as const;
/**
 *   admin          isAdmin (Editors, Settings, Invite, Settings quick action)
 *   createJobs     job.create (admin; members / editors with "Create jobs")
 *   createClients  client.create (admin; members with "Create jobs")
 *   teamWork       kept for older shells: admin ∨ member ⚑all ∨ editor ⚑teamJobs
 *   directory      team.view_members (admin, members)
 *   teamWorkloads  workloads.view_team
 *   analytics      analytics.view
 *   photographer   role = photographer (admins included): Home · Jobs · Clients
 *   editor         role = editor: My jobs · Calendar
 *   newJob         photographer ∧ job.create (the (+) tab; editors create from My jobs)
 *   advanced       admin ∧ the studio's Advanced tools switch is on (the Advanced group)
 */
export type NavGate = (typeof NAV_GATES)[number];
export type NavGates = Record<NavGate, boolean>;

/** Every gate closed (a staff persona with no extras sees only ungated items). */
export const NO_NAV_GATES: NavGates = {
  admin: false,
  createJobs: false,
  createClients: false,
  teamWork: false,
  directory: false,
  teamWorkloads: false,
  analytics: false,
  photographer: false,
  editor: false,
  newJob: false,
  advanced: false,
};

export interface NavItem {
  /** Stable id (used for keys and analytics). */
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Visible only when this gate is open. Omitted = every staff persona. */
  gate?: NavGate;
  /** Match only the exact pathname (default: prefix match). */
  exact?: boolean;
  /** Treat every path under this prefix as "inside" the item (e.g. Settings → /settings/*). */
  matchPrefix?: string;
  /** Optional short description for the command palette / tooltips. */
  description?: string;
  /** Keyboard chord for the command palette, e.g. "g d". Advanced only (plan §8: chords are hidden). */
  shortcut?: string;
}

export interface NavGroup {
  id: string;
  /** Group heading. Omitted for the top-level items. */
  label?: string;
  items: NavItem[];
  /** Gate applied to the whole group. */
  gate?: NavGate;
}

export interface QuickAction {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  gate?: NavGate;
  description?: string;
  /** Marks the primary action (rendered as the topbar button). */
  primary?: boolean;
}

export type IconProps = LucideProps;

/* ------------------------------------------------------------------ */
/*  Main navigation — plan §3                                          */
/* ------------------------------------------------------------------ */

export const navigation: NavGroup[] = [
  {
    id: "main",
    items: [
      {
        id: "home",
        label: "Home",
        href: "/home",
        icon: LayoutDashboard,
        gate: "photographer",
        description: "What needs you: ready to check, late, needs an editor",
      },
      {
        id: "my-jobs",
        label: "My jobs",
        href: "/my-jobs",
        icon: ListChecks,
        gate: "editor",
        description: "Changes asked, late, to do, waiting for a check",
      },
      {
        id: "jobs",
        label: "Jobs",
        href: "/jobs",
        icon: Briefcase,
        gate: "photographer",
        description: "Every job, by stage (List / Calendar)",
      },
      {
        id: "calendar",
        label: "Calendar",
        href: "/calendar",
        icon: CalendarDays,
        gate: "editor",
        description: "Your own due dates",
      },
      {
        id: "editors",
        label: "Editors",
        href: "/editors",
        icon: WandSparkles,
        gate: "admin",
        description: "On their desk · Late now · Finished · On time · Needed changes",
      },
      {
        id: "clients",
        label: "Clients",
        href: "/clients",
        icon: Building2,
        gate: "photographer",
        description: "Agencies and private clients (and the portal switch)",
      },
      {
        id: "settings",
        label: "Settings",
        href: "/settings/studio",
        icon: Settings,
        gate: "admin",
        matchPrefix: "/settings",
        description: "Studio, People, Types of shoot, My account, History",
      },
    ],
  },
  {
    id: "advanced",
    label: "Advanced",
    gate: "advanced",
    items: [
      { id: "kanban", label: "Board", href: "/workspace/kanban", icon: SquareKanban, description: "Drag jobs between the five stages" },
      { id: "timeline", label: "Timeline", href: "/workspace/timeline", icon: ChartNoAxesGantt, description: "Gantt view of jobs across time" },
      { id: "analytics", label: "Reports & stats", href: "/insights/analytics", icon: Activity, description: "Analytics, bottlenecks and reports" },
      { id: "automations", label: "Automations", href: "/settings/automations", icon: Zap, description: "When X happens, do Y" },
      { id: "workflows", label: "Workflows", href: "/settings/workflows", icon: Workflow, description: "Statuses and the transitions between them" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  User menu + quick actions + mobile tabs                            */
/* ------------------------------------------------------------------ */

/** Avatar menu (plan §3 topbar): My account · Help (· Log out, rendered by the shell). */
export const userMenuItems: NavItem[] = [
  { id: "account", label: "My account", href: "/settings/account", icon: CircleUser, description: "Your name, password and notifications" },
  { id: "help", label: "Help", href: "/help", icon: LifeBuoy, description: "The five stages and three roles, on one page" },
];

export const quickActions: QuickAction[] = [
  {
    id: "new-job",
    label: "New job",
    href: "/jobs/new",
    icon: Plus,
    gate: "createJobs",
    description: "Shoot → give it to an editor",
    primary: true,
  },
  {
    id: "new-client",
    label: "New client",
    href: "/clients/new",
    icon: Building2,
    gate: "createClients",
  },
  {
    id: "invite-user",
    label: "Invite someone",
    href: "/settings/people?invite=1",
    icon: UserPlus,
    gate: "admin",
  },
  {
    id: "open-settings",
    label: "Settings",
    href: "/settings/studio",
    icon: Settings,
    gate: "admin",
  },
  {
    id: "new-project",
    label: "New project",
    href: "/projects/new",
    icon: FolderPlus,
    gate: "advanced",
    description: "Projects are created silently from the address; this is the Advanced page",
  },
];

/** Bottom tab bar on small screens. `action` tabs trigger shell behaviour. */
export interface MobileTab {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  action?: "search" | "more";
  gate?: NavGate;
  /** The (+) tab: rendered as the raised primary button. */
  primary?: boolean;
  /** Carries the "to check" red count (plan §3). */
  badge?: "to_check";
}

/**
 * Plan §3 phone tabs. Owner: Home · Jobs · (+) · Editors · More. Extra photographer: Home · Jobs · (+) ·
 * More. Editor: My jobs · Calendar · Search · Me. One ordered list, filtered by gates.
 */
export const mobileTabs: MobileTab[] = [
  { id: "home", label: "Home", icon: LayoutDashboard, href: "/home", gate: "photographer", badge: "to_check" },
  { id: "my-jobs", label: "My jobs", icon: ListChecks, href: "/my-jobs", gate: "editor" },
  { id: "jobs", label: "Jobs", icon: Briefcase, href: "/jobs", gate: "photographer" },
  { id: "calendar", label: "Calendar", icon: CalendarDays, href: "/calendar", gate: "editor" },
  { id: "new-job", label: "New job", icon: Plus, href: "/jobs/new", gate: "newJob", primary: true },
  { id: "editors", label: "Editors", icon: WandSparkles, href: "/editors", gate: "admin" },
  { id: "search", label: "Search", icon: Search, action: "search", gate: "editor" },
  { id: "me", label: "Me", icon: CircleUser, href: "/settings/account", gate: "editor" },
  { id: "more", label: "More", icon: SlidersHorizontal, action: "more", gate: "photographer" },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** True when the entry has no gate or its gate is open. */
export function canAccess(entry: { gate?: NavGate }, gates: NavGates): boolean {
  return entry.gate === undefined || gates[entry.gate] === true;
}

/** The staff navigation tree with the groups/items whose gate is closed removed. */
export function navigationFor(gates: NavGates): NavGroup[] {
  return navigation
    .filter((group) => canAccess(group, gates))
    .map((group) => ({ ...group, items: group.items.filter((item) => canAccess(item, gates)) }))
    .filter((group) => group.items.length > 0);
}

/** Alias kept for shells written against the roles-v2 name. */
export const navigationForRole = navigationFor;

export function quickActionsFor(gates: NavGates): QuickAction[] {
  return quickActions.filter((action) => canAccess(action, gates));
}

export function mobileTabsFor(gates: NavGates): MobileTab[] {
  return mobileTabs.filter((tab) => canAccess(tab, gates));
}

/** Ids of every visible nav item + quick action (tests, command palette). */
export function visibleNavIds(gates: NavGates): { nav: string[]; quick: string[]; tabs: string[] } {
  return {
    nav: navigationFor(gates).flatMap((g) => g.items.map((i) => i.id)),
    quick: quickActionsFor(gates).map((a) => a.id),
    tabs: mobileTabsFor(gates).map((t) => t.id),
  };
}

/* ------------------------------------------------------------------ */
/*  Advanced routes (plan §8: hidden pages are blocked on the server)  */
/* ------------------------------------------------------------------ */

/** The advanced feature that owns `pathname`, or null for an always-available page. */
export function advancedFeatureForRoute(pathname: string): AdvancedFeature | null {
  for (const key of ADVANCED_FEATURES) {
    for (const route of ADVANCED_FEATURE_META[key].routes) {
      if (pathname === route || pathname.startsWith(`${route}/`)) return key;
    }
  }
  return null;
}

/** True when `pathname` is one of the pages hidden behind Settings → Studio → Advanced tools. */
export function isAdvancedRoute(pathname: string): boolean {
  return advancedFeatureForRoute(pathname) !== null;
}

/** The advanced feature that owns an `/api/*` path (prefix match), or null. */
export function advancedFeatureForApi(pathname: string): AdvancedFeature | null {
  for (const key of ADVANCED_FEATURES) {
    for (const prefix of ADVANCED_FEATURE_META[key].apiPrefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return key;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Client portal navigation (docs/ROLES.md §10: Your work · Notifications · Account · Log out) */
/* ------------------------------------------------------------------ */

export const portalNavigation: NavItem[] = [
  { id: "portal-work", label: "Your work", href: "/portal", icon: Images, exact: true, description: "Work your studio has shared with you" },
  { id: "portal-notifications", label: "Notifications", href: "/portal/notifications", icon: Bell },
  { id: "portal-account", label: "Account", href: "/portal/account", icon: CircleUser, description: "Your name, password and notifications" },
];

/** Logout target shared by the staff shell and the portal header. */
export const LOGOUT_ACTION = "/api/auth/logout";

/** Whether `pathname` is "inside" the nav item. */
export function isNavItemActive(pathname: string, item: Pick<NavItem, "href" | "exact" | "matchPrefix">): boolean {
  if (item.exact) return pathname === item.href;
  if (pathname === item.href) return true;
  if (pathname.startsWith(`${item.href}/`)) return true;
  return item.matchPrefix !== undefined && (pathname === item.matchPrefix || pathname.startsWith(`${item.matchPrefix}/`));
}

export interface NavMatch {
  group: NavGroup;
  item: NavItem;
}

/** Longest-prefix match for the current path (for breadcrumbs / titles). */
export function findNavMatch(pathname: string, groups: NavGroup[] = navigation): NavMatch | null {
  let best: NavMatch | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (isNavItemActive(pathname, item) && (!best || item.href.length > best.item.href.length)) {
        best = { group, item };
      }
    }
  }
  return best;
}

/** Topbar heading for the current route: page title plus optional breadcrumb eyebrow. */
export interface RouteTitle {
  title: string;
  eyebrow?: string;
}

/**
 * Routes that are not sidebar items but still need a topbar title: the Settings tabs, detail pages,
 * personal pages reached from the bell / search / user menu. Checked in order after the role-filtered
 * nav and the user menu.
 */
export const extraRouteTitles: ReadonlyArray<{ pattern: RegExp; title: string; eyebrow?: string }> = [
  { pattern: /^\/jobs\/new(?:\/|$)/, title: "New job", eyebrow: "Jobs" },
  { pattern: /^\/jobs\/[^/]+\/edit(?:\/|$)/, title: "Edit details", eyebrow: "Jobs" },
  { pattern: /^\/jobs\/[^/]+(?:\/|$)/, title: "Job", eyebrow: "Jobs" },
  { pattern: /^\/editors\/[^/]+(?:\/|$)/, title: "Editor", eyebrow: "Editors" },
  { pattern: /^\/clients\/new(?:\/|$)/, title: "New client", eyebrow: "Clients" },
  { pattern: /^\/clients\/[^/]+(?:\/|$)/, title: "Client", eyebrow: "Clients" },
  { pattern: /^\/settings\/studio(?:\/|$)/, title: "Studio", eyebrow: "Settings" },
  { pattern: /^\/settings\/people(?:\/|$)/, title: "People", eyebrow: "Settings" },
  { pattern: /^\/settings\/shoot-types(?:\/|$)/, title: "Types of shoot", eyebrow: "Settings" },
  { pattern: /^\/settings\/account(?:\/|$)/, title: "My account", eyebrow: "Settings" },
  { pattern: /^\/settings\/history(?:\/|$)/, title: "History", eyebrow: "Settings" },
  { pattern: /^\/settings\/roles(?:\/|$)/, title: "Roles", eyebrow: "Advanced" },
  { pattern: /^\/settings\/teams(?:\/|$)/, title: "Teams", eyebrow: "Advanced" },
  { pattern: /^\/settings\/appearance(?:\/|$)/, title: "Appearance", eyebrow: "Advanced" },
  { pattern: /^\/insights\/bottlenecks(?:\/|$)/, title: "Bottlenecks", eyebrow: "Advanced" },
  { pattern: /^\/insights\/reports(?:\/|$)/, title: "Reports", eyebrow: "Advanced" },
  { pattern: /^\/projects(?:\/|$)/, title: "Projects", eyebrow: "Advanced" },
  { pattern: /^\/notifications(?:\/|$)/, title: "Notifications" },
  { pattern: /^\/search(?:\/|$)/, title: "Search" },
  { pattern: /^\/help(?:\/|$)/, title: "Help" },
  { pattern: /^\/team\/users\/[^/]+(?:\/|$)/, title: "Team member", eyebrow: "Team" },
];

/**
 * Resolves the topbar title for `pathname`: `extraRouteTitles` (Settings tabs, detail pages) first, then
 * the longest matching nav item the viewer can see (with its group as eyebrow), then the user-menu
 * pages. Null only for routes nobody has named (the shell then falls back to the product name).
 */
export function resolveRouteTitle(pathname: string, groups: NavGroup[] = navigation): RouteTitle | null {
  // Settings tabs and detail pages name themselves before the nav match: the "Settings" item points at
  // /settings/studio (matchPrefix /settings), yet the page is titled "Studio" under a "Settings" eyebrow.
  const extra = extraRouteTitles.find((entry) => entry.pattern.test(pathname));
  if (extra) return { title: extra.title, eyebrow: extra.eyebrow };
  const match = findNavMatch(pathname, groups);
  if (match) return { title: match.item.label, eyebrow: match.group.label };
  const personal = userMenuItems.find((item) => isNavItemActive(pathname, item));
  if (personal) return { title: personal.label };
  return null;
}

/** Flat list of every nav item (for the command palette). */
export function flattenNavigation(groups: NavGroup[] = navigation): Array<NavItem & { group?: string }> {
  return groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));
}

/** Siren is exported for "needs attention" surfaces so icon choice stays consistent. */
export const attentionIcon: LucideIcon = Siren;
