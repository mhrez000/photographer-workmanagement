import type { LucideIcon } from "lucide-react";
import { Bell, Building2, CircleUser, KeyRound, LifeBuoy, Palette, Tag, Users, UsersRound, Workflow, Zap } from "lucide-react";

export interface SettingsNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export interface SettingsNavSection {
  id: string;
  label: string;
  items: SettingsNavItem[];
}

const STUDIO: SettingsNavItem[] = [
  { href: "/settings/organisation", label: "Organisation", icon: Building2, description: "Name, timezone, thresholds, default photographer" },
  { href: "/settings/users", label: "Users", icon: Users, description: "Invite people, admins and permission switches" },
  { href: "/settings/roles", label: "Roles", icon: KeyRound, description: "Photographer, Editor, Client: who can do what" },
  { href: "/settings/teams", label: "Teams", icon: UsersRound, description: "Groups, leads and memberships" },
  { href: "/settings/workflows", label: "Workflows", icon: Workflow, description: "Statuses and transitions" },
  { href: "/settings/job-types", label: "Job types", icon: Tag, description: "Types, workflows and default hours" },
  { href: "/settings/automations", label: "Automations", icon: Zap, description: "When X happens, do Y" },
];

const PERSONAL: SettingsNavItem[] = [
  { href: "/settings/profile", label: "Profile", icon: CircleUser, description: "Name, avatar, password and your access" },
  { href: "/settings/notifications", label: "Notifications", icon: Bell, description: "What you're notified about" },
  { href: "/settings/appearance", label: "Appearance", icon: Palette, description: "Theme and density on this device" },
];

const HELP: SettingsNavItem[] = [{ href: "/help", label: "Help & shortcuts", icon: LifeBuoy, description: "Shortcuts, statuses, roles" }];

/**
 * Settings sub-navigation. Studio settings are for admins only (`settings.view`,
 * docs/ROLES.md §10): pass `showStudio = allowed(ctx, "settings.view")`.
 */
export function settingsNavFor(showStudio: boolean): SettingsNavSection[] {
  const sections: SettingsNavSection[] = [];
  if (showStudio) sections.push({ id: "studio", label: "Studio", items: STUDIO });
  sections.push({ id: "personal", label: "Personal", items: PERSONAL });
  sections.push({ id: "help", label: "Support", items: HELP });
  return sections;
}

/** Longest-prefix match so /settings/users/abc highlights "Users". */
export function activeSettingsHref(pathname: string, sections: SettingsNavSection[]): string | null {
  let best: string | null = null;
  for (const s of sections) {
    for (const item of s.items) {
      if ((pathname === item.href || pathname.startsWith(`${item.href}/`)) && (!best || item.href.length > best.length)) best = item.href;
    }
  }
  return best;
}
