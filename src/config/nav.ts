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
  type LucideProps,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type RoleKey = "owner" | "manager" | "photographer" | "editor";

export const ALL_ROLES: readonly RoleKey[] = ["owner", "manager", "photographer", "editor"];
export const MANAGEMENT_ROLES: readonly RoleKey[] = ["owner", "manager"];

export interface NavItem {
  /** Stable id (used for keys and analytics). */
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Allow-list. Omitted = visible to every role. */
  roles?: readonly RoleKey[];
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
  /** Allow-list applied to the whole group. */
  roles?: readonly RoleKey[];
}

export interface QuickAction {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  roles?: readonly RoleKey[];
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
        roles: ["owner", "manager", "photographer"],
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
    roles: MANAGEMENT_ROLES,
    items: [
      {
        id: "photographers",
        label: "Photographers",
        href: "/team/photographers",
        icon: Camera,
        description: "Photographers and the jobs they own",
      },
      {
        id: "editors",
        label: "Editors",
        href: "/team/editors",
        icon: WandSparkles,
        description: "Editors, capacity and current queue",
      },
      {
        id: "workloads",
        label: "Workloads",
        href: "/team/workloads",
        icon: Gauge,
        description: "Who is healthy, near capacity or overloaded",
      },
      {
        id: "performance",
        label: "Performance",
        href: "/team/performance",
        icon: BarChart3,
        description: "Turnaround, on-time rate and revision rate per person",
      },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    roles: MANAGEMENT_ROLES,
    items: [
      {
        id: "analytics",
        label: "Analytics",
        href: "/insights/analytics",
        icon: Activity,
        description: "Volume, throughput and trends",
      },
      {
        id: "bottlenecks",
        label: "Bottlenecks",
        href: "/insights/bottlenecks",
        icon: Funnel,
        description: "Where jobs are getting stuck",
      },
      {
        id: "reports",
        label: "Reports",
        href: "/insights/reports",
        icon: ClipboardList,
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
        roles: MANAGEMENT_ROLES,
        description: "Studio name, timezone and defaults",
      },
      {
        id: "users",
        label: "Users",
        href: "/settings/users",
        icon: Users,
        roles: MANAGEMENT_ROLES,
        description: "Invite people and manage access",
      },
      {
        id: "roles",
        label: "Roles",
        href: "/settings/roles",
        icon: KeyRound,
        roles: MANAGEMENT_ROLES,
        description: "What each role can see and do",
      },
      {
        id: "workflows",
        label: "Workflows",
        href: "/settings/workflows",
        icon: Workflow,
        roles: MANAGEMENT_ROLES,
        description: "Statuses and the transitions between them",
      },
      {
        id: "job-types",
        label: "Job Types",
        href: "/settings/job-types",
        icon: Tag,
        roles: MANAGEMENT_ROLES,
        description: "Real estate, portrait, commercial, …",
      },
      {
        id: "automations",
        label: "Automations",
        href: "/settings/automations",
        icon: Zap,
        roles: MANAGEMENT_ROLES,
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
    roles: ["owner", "manager", "photographer"],
    description: "Create a job and assign it",
    primary: true,
  },
  {
    id: "new-project",
    label: "New project",
    href: "/projects/new",
    icon: FolderPlus,
    roles: MANAGEMENT_ROLES,
    description: "Group upcoming jobs for a client",
  },
  {
    id: "new-client",
    label: "New client",
    href: "/clients/new",
    icon: Building2,
    roles: MANAGEMENT_ROLES,
  },
  {
    id: "invite-user",
    label: "Invite a user",
    href: "/settings/users?invite=1",
    icon: UserPlus,
    roles: MANAGEMENT_ROLES,
  },
  {
    id: "open-settings",
    label: "Settings",
    href: "/settings/organisation",
    icon: Settings,
    roles: MANAGEMENT_ROLES,
  },
];

/** Bottom tab bar on small screens. `action` tabs trigger shell behaviour. */
export interface MobileTab {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  action?: "search" | "more";
  roles?: readonly RoleKey[];
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

export function isRoleKey(value: string): value is RoleKey {
  return (ALL_ROLES as readonly string[]).includes(value);
}

export function canAccess(entry: { roles?: readonly RoleKey[] }, role: RoleKey): boolean {
  return !entry.roles || entry.roles.includes(role);
}

/** The navigation tree with groups/items the role cannot see removed. */
export function navigationForRole(role: RoleKey): NavGroup[] {
  return navigation
    .filter((group) => canAccess(group, role))
    .map((group) => ({ ...group, items: group.items.filter((item) => canAccess(item, role)) }))
    .filter((group) => group.items.length > 0);
}

export function quickActionsForRole(role: RoleKey): QuickAction[] {
  return quickActions.filter((action) => canAccess(action, role));
}

export function mobileTabsForRole(role: RoleKey): MobileTab[] {
  return mobileTabs.filter((tab) => canAccess(tab, role));
}

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

/** Flat list of every nav item (for the command palette). */
export function flattenNavigation(groups: NavGroup[] = navigation): Array<NavItem & { group?: string }> {
  return groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));
}

/** Siren is exported for "needs attention" surfaces so icon choice stays consistent. */
export const attentionIcon: LucideIcon = Siren;
