import type { RoleKey } from "@/config/nav";

/** The minimum the shell needs to know about the signed-in user. */
export interface ShellUser {
  id: string;
  name: string;
  email: string;
  role: RoleKey;
  /** Optional stored CSS colour for the avatar; otherwise derived from the name. */
  avatarColour?: string | null;
}

export const ROLE_LABELS: Record<RoleKey, string> = {
  owner: "Owner",
  manager: "Manager",
  photographer: "Photographer",
  editor: "Editor",
};

/** Custom DOM event dispatched when the global search should open. */
export const OPEN_SEARCH_EVENT = "proofline:open-search";

export const SIDEBAR_STORAGE_KEY = "proofline.sidebar-collapsed";
