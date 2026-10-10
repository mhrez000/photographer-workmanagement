import { cookies } from "next/headers";
import { VIEW_SCOPE_COOKIE } from "@/lib/constants";

/**
 * The `pwm_scope` cookie ("My shoots" | "Whole business", docs/ROLES.md §8) for list
 * routes. Queries never read cookies themselves; they resolve `?scope=` (wins) and this
 * value through `viewScopeFor`, which ignores both for people without the switch.
 */
export async function scopeCookie(): Promise<{ scopeCookie: string | undefined }> {
  return { scopeCookie: (await cookies()).get(VIEW_SCOPE_COOKIE)?.value };
}
