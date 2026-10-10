import "server-only";
import { cookies } from "next/headers";
import { VIEW_SCOPE_COOKIE, type ViewScope } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { viewScopeFor } from "@/server/queries/scope";

export interface PageScope {
  /** Resolved "My shoots | Whole business" scope (null = the viewer has no scope switch, docs/ROLES.md §8). */
  scope: ViewScope | null;
  /** The raw `pwm_scope` cookie, passed to list queries as `{ scopeCookie }` (the `?scope=` param travels in the filters). */
  scopeCookie: string | null;
}

/**
 * Personal vs business view for a Server Component page (same resolver as the
 * list queries, `viewScopeFor`): the `?scope=` param wins over the cookie; viewers without `view.business_scope` always get null
 * (the param is ignored, never a widening).
 */
export async function pageScope(ctx: AuthContext, requested?: string | null): Promise<PageScope> {
  let scopeCookie: string | null = null;
  try {
    scopeCookie = (await cookies()).get(VIEW_SCOPE_COOKIE)?.value ?? null;
  } catch {
    scopeCookie = null;
  }
  return { scope: viewScopeFor(ctx, { scope: requested ?? null, scopeCookie }), scopeCookie };
}
