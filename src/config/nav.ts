import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  Bell,
  Briefcase,
  Building2,
  CalendarDays,
  Camera,
  ChartNoAxesGantt,
  CircleUser,
  ClipboardList,
  FolderKanban,
  Funnel,
  Gauge,
  History,
  KeyRound,
  LayoutDashboard,
  LayoutList,
  LifeBuoy,
  ListChecks,
  Palette,
  Search,
  Settings,
  Siren,
  SlidersHorizontal,
  SquareKanban,
  Tag,
  UserPlus,
  Users,
  UsersRound,
  WandSparkles,
  Workflow,
  Zap,
  Plus,
  FolderPlus,
  Images,
  type LucideProps,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Roles v2 (docs/ROLES.md §10): items no longer carry role lists. Each entry
 * takes an optional `gate`; the (app) layout computes `NavGates` server-side
 * with `can()` (src/server/nav-gates.ts → `navGatesFor(ctx)`) and the shell
 * filters with `navigationFor(gates)` etc. No gate = every staff persona.
 * Clients never get this navigation: the portal uses `portalNavigation`.
 */
export const NAV_GATES = ["admin", "createJobs", "createClients", "teamWork", "directory", "teamWorkloads", "analytics"] as const;
/**
 *   admin          isAdmin (settings items, Invite, Settings quick action)
 *   createJobs     job.create (admin; members / editors with "Create jobs")
 *   createClients  client.create (admin; members with "Create jobs")
 *   teamWork       admin ∨ member ⚑all ∨ editor ⚑teamJobs
 *   directory      team.view_members (admin, members)
 *   teamWorkloads  workloads.view_team
 *   analytics      analytics.view (also gates Performance)
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
  /** Optional short description for the command palette / tooltips. */
  description?: string;
  /** Keyboard chord for the command palette, e.g. "g d". */
  shortcut?: string;
}

export interface NavGroup {
  id: string;
  /** Group heading. Omitted for the top-level Dashboard entry. */
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
/*  Main navigation — spec §27                                         */
/* ------------------------------------------------------------------ */

export const navigation: NavGroup[] = [
  {
    id: "home",
    items: [
      {
        id: "dashboard",
        label: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        description: "What is happening in the business right now",
        shortcut: "g d",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "all-work",
        label: "All Work",
        href: "/workspace/all",
        icon: LayoutList,
        description: "Every job in one sortable, filterable table",
        shortcut: "g a",
      },
      {
        id: "my-work",
        label: "My Work",
        href: "/workspace/my",
        icon: ListChecks,
        description: "Your queue: due today, overdue, awaiting review",
        shortcut: "g m",
      },
      {
        id: "team-work",
        label: "Team Work",
        href: "/workspace/team",
        icon: UsersRound,
        gate: "teamWork",
        description: "What everyone on the team is working on",
      },
      {
        id: "kanban",
        label: "Kanban",
        href: "/workspace/kanban",
        icon: SquareKanban,
        description: "Drag jobs between workflow stages",
        shortcut: "g k",
      },
      {
        id: "calendar",
        label: "Calendar",
        href: "/workspace/calendar",
        icon: CalendarDays,
        description: "Shoot and due dates by day, week and month",
        shortcut: "g c",
      },
      {
        id: "timeline",
        label: "Timeline",
        href: "/workspace/timeline",
        icon: ChartNoAxesGantt,
        description: "Gantt view of jobs across time",
      },
    ],
  },
  {
    id: "production",
    label: "Production",
    items: [
      {
        id: "jobs",
        label: "Jobs",
        href: "/jobs",
        icon: Briefcase,
        description: "All jobs, their status and history",
        shortcut: "g j",
      },
      {
        id: "projects",
        label: "Projects",
        href: "/projects",
        icon: FolderKanban,
        description: "Group jobs into client projects",
      },
      {
        id: "clients",
        label: "Clients",
        href: "/clients",
        icon: Building2,
        description: "Agencies, developers and private clients",
      },
    ],
  },
  {
    id: "team",
    label: "Team",
    items: [
      {
        id: "photographers",
        label: "Photographers",
        href: "/team/photographers",
        icon: Camera,
        gate: "directory",
        description: "Photographers and the jobs they own",
      },
      {
        id: "editors",
        label: "Editors",
        href: "/team/editors",
        icon: WandSparkles,
        gate: "directory",
        description: "Editors, capacity and current queue",
      },
      {
        id: "workloads",
        label: "Workloads",
        href: "/team/workloads",
        icon: Gauge,
        gate: "teamWorkloads",
        description: "Who is healthy, near capacity or overloaded",
      },
      {
        id: "performance",
        label: "Performance",
        href: "/team/performance",
        icon: BarChart3,
        gate: "analytics",
        description: "Turnaround, on-time rate and revision rate per person",
      },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    items: [
      {
        id: "analytics",
        label: "Analytics",
        href: "/insights/analytics",
        icon: Activity,
        gate: "analytics",
        description: "Volume, throughput and trends",
      },
      {
        id: "bottlenecks",
        label: "Bottlenecks",
        href: "/insights/bottlenecks",
        icon: Funnel,
        gate: "analytics",
        description: "Where jobs are getting stuck",
      },
      {
        id: "reports",
        label: "Reports",
        href: "/insights/reports",
        icon: ClipboardList,
        gate: "analytics",
        description: "Production, editor, photographer and business reports",
      },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    items: [
      {
        id: "activity-log",
        label: "Activity Log",
        href: "/activity",
        icon: History,
        description: "Every change, by everyone, forever",
        shortcut: "g l",
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        id: "organisation",
        label: "Organisation",
        href: "/settings/organisation",
        icon: Building2,
        gate: "admin",
        description: "Studio name, timezone and defaults",
      },
      {
        id: "users",
        label: "Users",
        href: "/settings/users",
        icon: Users,
        gate: "admin",
        description: "Invite people and manage access",
      },
      {
        id: "roles",
        label: "Roles",
        href: "/settings/roles",
        icon: KeyRound,
        gate: "admin",
        description: "What each role can see and do",
      },
      {
        id: "teams",
        label: "Teams",
        href: "/settings/teams",
        icon: UsersRound,
        gate: "admin",
        description: "Groups, leads and memberships",
      },
      {
        id: "workflows",
        label: "Workflows",
        href: "/settings/workflows",
        icon: Workflow,
        gate: "admin",
        description: "Statuses and the transitions between them",
      },
      {
        id: "job-types",
        label: "Job Types",
        href: "/settings/job-types",
        icon: Tag,
        gate: "admin",
        description: "Real estate, portrait, commercial, …",
      },
      {
        id: "automations",
        label: "Automations",
        href: "/settings/automations",
        icon: Zap,
        gate: "admin",
        description: "When X happens, do Y",
      },
      {
        id: "notifications",
        label: "Notifications",
        href: "/settings/notifications",
        icon: Bell,
        description: "What you get notified about, and how",
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  User menu + quick actions + mobile tabs                            */
/* ------------------------------------------------------------------ */

export const userMenuItems: NavItem[] = [
  { id: "profile", label: "Your profile", href: "/settings/profile", icon: CircleUser },
  { id: "notification-settings", label: "Notification settings", href: "/settings/notifications", icon: Bell },
  { id: "appearance", label: "Appearance", href: "/settings/appearance", icon: Palette },
  { id: "help", label: "Help & shortcuts", href: "/help", icon: LifeBuoy },
];

export const quickActions: QuickAction[] = [
  {
    id: "new-job",
    label: "New job",
    href: "/jobs/new",
    icon: Plus,
    gate: "createJobs",
    description: "Create a job and assign it",
    primary: true,
  },
  {
    id: "new-project",
    label: "New project",
    href: "/projects/new",
    icon: FolderPlus,
    gate: "createClients",
    description: "Group upcoming jobs for a client",
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
    label: "Invite a user",
    href: "/settings/users?invite=1",
    icon: UserPlus,
    gate: "admin",
  },
  {
    id: "open-settings",
    label: "Settings",
    href: "/settings/organisation",
    icon: Settings,
    gate: "admin",
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
}

export const mobileTabs: MobileTab[] = [
  { id: "dashboard", label: "Home", icon: LayoutDashboard, href: "/dashboard" },
  { id: "my-work", label: "My Work", icon: ListChecks, href: "/workspace/my" },
  { id: "kanban", label: "Kanban", icon: SquareKanban, href: "/workspace/kanban" },
  { id: "search", label: "Search", icon: Search, action: "search" },
  { id: "more", label: "More", icon: SlidersHorizontal, action: "more" },
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
export function isNavItemActive(pathname: string, item: Pick<NavItem, "href" | "exact">): boolean {
  if (item.exact) return pathname === item.href;
  if (pathname === item.href) return true;
  return pathname.startsWith(`${item.href}/`);
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
 * Routes that are not sidebar items but still need a topbar title: personal
 * pages reached from the bell / search / user menu, and dynamic detail pages.
 * Checked in order after the role-filtered nav and the user menu.
 */
export const extraRouteTitles: ReadonlyArray<{ pattern: RegExp; title: string; eyebrow?: string }> = [
  { pattern: /^\/notifications(?:\/|$)/, title: "Notifications" },
  { pattern: /^\/search(?:\/|$)/, title: "Search" },
  { pattern: /^\/team\/users\/[^/]+(?:\/|$)/, title: "Team member", eyebrow: "Team" },
];

/**
 * Resolves the topbar title for `pathname`: the longest matching nav item the
 * viewer can see (with its group as eyebrow), then the user-menu pages, then
 * `extraRouteTitles`. Null only for routes nobody has named (the shell then
 * falls back to the product name).
 */
export function resolveRouteTitle(pathname: string, groups: NavGroup[] = navigation): RouteTitle | null {
  const match = findNavMatch(pathname, groups);
  if (match) return { title: match.item.label, eyebrow: match.group.label };
  const personal = userMenuItems.find((item) => isNavItemActive(pathname, item));
  if (personal) return { title: personal.label };
  const extra = extraRouteTitles.find((entry) => entry.pattern.test(pathname));
  if (extra) return { title: extra.title, eyebrow: extra.eyebrow };
  return null;
}

/** Flat list of every nav item (for the command palette). */
export function flattenNavigation(groups: NavGroup[] = navigation): Array<NavItem & { group?: string }> {
  return groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));
}

/** Siren is exported for "needs attention" surfaces so icon choice stays consistent. */
export const attentionIcon: LucideIcon = Siren;
