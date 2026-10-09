import type { LucideIcon } from "lucide-react";
import { Bell, Building2, CircleUser, KeyRound, LifeBuoy, Palette, Tag, Users, UsersRound, Workflow, Zap } from "lucide-react";
import type { Role } from "@/lib/constants";

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
  { href: "/settings/organisation", label: "Organisation", icon: Building2, description: "Name, timezone, thresholds, visibility" },
  { href: "/settings/users", label: "Users", icon: Users, description: "Invite people and manage access" },
  { href: "/settings/roles", label: "Roles", icon: KeyRound, description: "What each role can see and do" },
  { href: "/settings/teams", label: "Teams", icon: UsersRound, description: "Groups, leads and memberships" },
  { href: "/settings/workflows", label: "Workflows", icon: Workflow, description: "Statuses and transitions" },
  { href: "/settings/job-types", label: "Job types", icon: Tag, description: "Types, workflows and default hours" },
  { href: "/settings/automations", label: "Automations", icon: Zap, description: "When X happens, do Y" },
];

const PERSONAL: SettingsNavItem[] = [
  { href: "/settings/profile", label: "Profile", icon: CircleUser, description: "Name, avatar and password" },
  { href: "/settings/notifications", label: "Notifications", icon: Bell, description: "What you're notified about" },
  { href: "/settings/appearance", label: "Appearance", icon: Palette, description: "Theme and density on this device" },
];

const HELP: SettingsNavItem[] = [{ href: "/help", label: "Help & shortcuts", icon: LifeBuoy, description: "Shortcuts, statuses, roles" }];

/** Settings sub-navigation for a role. Studio settings are owner/manager only (settings.view). */
export function settingsNavFor(role: Role): SettingsNavSection[] {
  const sections: SettingsNavSection[] = [];
  if (role === "owner" || role === "manager") sections.push({ id: "studio", label: "Studio", items: STUDIO });
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
