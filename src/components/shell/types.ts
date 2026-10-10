import { displayRoleLabel, type Role } from "@/lib/constants";

/** The minimum the shell needs to know about the signed-in user. */
export interface ShellUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Roles v2: admin photographer = "Owner / Photographer". */
  isAdmin?: boolean;
  /** Optional job title shown after the persona ("Photographer (team member) · Senior photographer"). */
  title?: string | null;
  /** Optional stored CSS colour for the avatar; otherwise derived from the name. */
  avatarColour?: string | null;
}

/** Persona badge text for the shell (docs/ROLES.md §11). */
export function shellRoleLabel(user: Pick<ShellUser, "role" | "isAdmin" | "title">): string {
  return displayRoleLabel(user);
}

/** Custom DOM event dispatched when the global search should open. */
export const OPEN_SEARCH_EVENT = "proofline:open-search";

export const SIDEBAR_STORAGE_KEY = "proofline.sidebar-collapsed";
