"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { mobileTabsFor, navigationFor, quickActionsFor, resolveRouteTitle, userMenuItems, type NavGates, type NavGroup } from "@/config/nav";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/toast";
import { Brand } from "./brand-mark";
import { MobileTabBar } from "./mobile-tab-bar";
import { NavList } from "./nav-list";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { OPEN_SEARCH_EVENT, shellRoleLabel, type ShellUser } from "./types";
import { useIsMac, useSidebarCollapsed } from "./use-shell-state";

export interface AppShellProps {
  user: ShellUser;
  orgName: string;
  unreadCount: number;
  children: React.ReactNode;
  /** Called by the ⌘K button / shortcut. Defaults to dispatching `proofline:open-search` on `window`. */
  onOpenSearch?: () => void;
  /** POST target for the logout form in the user menu. */
  logoutAction?: string;
  /** Override the derived topbar title. */
  title?: React.ReactNode;
  /** Toast position. */
  toasterPosition?: "bottom-right" | "bottom-center" | "top-right" | "top-center";
  /** Navigation gates computed server-side with can() (docs/SIMPLIFICATION-PLAN.md §3). */
  navGates: NavGates;
  /** Jobs waiting for the viewer to check (the red count on the phone Home tab). */
  toCheckCount?: number;
}

/**
 * Authenticated application chrome (docs/SIMPLIFICATION-PLAN.md §3): a five-item
 * sidebar (desktop), the "More" drawer (phones — opened from the More tab; the
 * topbar hamburger only appears when there is no tab bar), a sticky topbar, the
 * bottom tab bar and toasts. There is no scope switch: who you are decides which
 * jobs you see.
 */
export function AppShell({
  user,
  orgName,
  unreadCount,
  children,
  onOpenSearch,
  logoutAction = "/api/auth/logout",
  title,
  toasterPosition = "bottom-right",
  navGates,
  toCheckCount = 0,
}: AppShellProps) {
  const pathname = usePathname();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const isMac = useIsMac();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  // Close the drawer whenever the route changes (state derived from props during render).
  const [navPathname, setNavPathname] = React.useState(pathname);
  if (navPathname !== pathname) {
    setNavPathname(pathname);
    if (mobileNavOpen) setMobileNavOpen(false);
  }

  const groups = React.useMemo(() => navigationFor(navGates), [navGates]);
  const tabs = React.useMemo(() => mobileTabsFor(navGates), [navGates]);
  // "+ New job" hides on the New job page itself: pressing it there would do nothing visible.
  const primaryAction = React.useMemo(() => {
    const action = quickActionsFor(navGates).find((a) => a.primary);
    return action && pathname.startsWith(action.href) ? undefined : action;
  }, [navGates, pathname]);
  // Editors have one list, "My jobs": the topbar never calls it "Jobs" for them.
  const heading = React.useMemo(() => {
    const resolved = resolveRouteTitle(pathname, groups);
    return resolved && navGates.editor && resolved.eyebrow === "Jobs" ? { ...resolved, eyebrow: "My jobs" } : resolved;
  }, [pathname, groups, navGates.editor]);

  // The "More" drawer lists what the tab bar does not already show (plan §3: Clients, Settings…),
  // plus the personal pages. Falls back to the whole menu when every item is a tab.
  const drawerGroups = React.useMemo<NavGroup[]>(() => {
    const tabHrefs = new Set(tabs.flatMap((t) => (t.href ? [t.href] : [])));
    const rest = groups.map((g) => ({ ...g, items: g.items.filter((i) => !tabHrefs.has(i.href)) })).filter((g) => g.items.length > 0);
    const main = rest.length > 0 ? rest : groups;
    return [...main, { id: "personal", label: "You", items: userMenuItems }];
  }, [groups, tabs]);

  const openSearch = React.useCallback(() => {
    if (onOpenSearch) {
      onOpenSearch();
      return;
    }
    window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT));
  }, [onOpenSearch]);

  // Global shortcuts: ⌘/Ctrl+K opens search, "[" toggles the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key === "[" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) {
          return;
        }
        event.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openSearch, toggleCollapsed]);

  return (
    <div data-sidebar={collapsed ? "collapsed" : "expanded"} className="min-h-dvh bg-canvas text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop focus-ring"
      >
        Skip to content
      </a>

      <Sidebar groups={groups} pathname={pathname} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} orgName={orgName} showChords={navGates.advanced} />

      <div
        className={cn(
          "flex min-h-dvh flex-col transition-[padding] duration-(--motion-slow) ease-out-soft",
          collapsed ? "lg:pl-(--sidebar-width-collapsed)" : "lg:pl-(--sidebar-width)",
        )}
      >
        <Topbar
          user={user}
          unreadCount={unreadCount}
          heading={heading}
          title={title}
          isMac={isMac}
          onOpenMenu={() => setMobileNavOpen(true)}
          onOpenSearch={openSearch}
          primaryAction={primaryAction}
          logoutAction={logoutAction}
          menuButton={tabs.length === 0}
        />
        <main id="main" tabIndex={-1} className="flex flex-1 flex-col overflow-x-clip pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px))] outline-none lg:pb-0">
          {children}
        </main>
      </div>

      <MobileTabBar
        tabs={tabs}
        pathname={pathname}
        onOpenSearch={openSearch}
        onOpenMore={() => setMobileNavOpen(true)}
        moreOpen={mobileNavOpen}
        badges={{ to_check: toCheckCount }}
      />

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen} side="left" size="sm" aria-label="More">
        <SheetHeader className="py-3">
          <SheetTitle className="sr-only">More</SheetTitle>
          <Brand subtitle={orgName} />
        </SheetHeader>
        <SheetBody className="px-3">
          <NavList groups={drawerGroups} pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
        </SheetBody>
        <div className="shrink-0 border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-md px-2 py-2">
            <Avatar name={user.name} size="md" colour={user.avatarColour ?? undefined} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{user.name}</div>
              <div className="truncate text-xs text-ink-muted">{user.email}</div>
            </div>
            <Badge variant="outline" size="sm">
              {shellRoleLabel(user)}
            </Badge>
          </div>
          <form action={logoutAction} method="post" className="mt-1">
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start text-danger hover:bg-danger-soft hover:text-danger" leadingIcon={<LogOut aria-hidden="true" />}>
              Log out
            </Button>
          </form>
        </div>
      </Sheet>

      <Toaster position={toasterPosition} />
    </div>
  );
}
