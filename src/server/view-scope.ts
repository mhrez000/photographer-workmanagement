/**
 * Personal vs business view (docs/ROLES.md §8) — the ONE resolver every
 * route and page uses for `?scope=` / the `pwm_scope` cookie.
 *
 *   const scope = await resolveScope(ctx, param(sp, "scope"));     // null = no scope filter
 *   db.select().from(jobs).where(scopedJobsWhere(ctx, scope))
 *   const m = resolveMetricScope(ctx, scope);                       // dashboard / counts
 *
 * "My shoots" = jobs where I am the photographer (`photographer_id = me`) —
 * never `managesJob`. Non-holders of `view.business_scope` always get null:
 * any `?scope=` is ignored (never an error, never a widening).
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { VIEW_SCOPES, VIEW_SCOPE_COOKIE, type ViewScope } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { can, hasBusinessView, visibleJobsWhere } from "@/server/auth/permissions";

export type { ViewScope };

function asScope(value: string | null | undefined): ViewScope | null {
  return typeof value === "string" && (VIEW_SCOPES as readonly string[]).includes(value) ? (value as ViewScope) : null;
}

/**
 * Pure resolver: non-holders → null; a valid `requested` wins over the cookie;
 * else a valid cookie; else "business".
 */
export function resolveScopeFrom(ctx: AuthContext, requested?: string | null, cookie?: string | null): ViewScope | null {
  if (!can(ctx, "view.business_scope")) return null;
  return asScope(requested) ?? asScope(cookie) ?? "business";
}

/** Reads the `pwm_scope` cookie of the current request (undefined outside a request scope). */
async function readScopeCookie(): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    return jar.get(VIEW_SCOPE_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

/**
 * `resolveScopeFrom` with the cookie of the current request. Pass `opts.cookie`
 * to skip the cookie read (tests, scripts).
 */
export async function resolveScope(
  ctx: AuthContext,
  requested?: string | null,
  opts: { cookie?: string | null } = {},
): Promise<ViewScope | null> {
  if (!can(ctx, "view.business_scope")) return null;
  const cookie = "cookie" in opts ? opts.cookie : await readScopeCookie();
  return resolveScopeFrom(ctx, requested, cookie);
}

/** `jobs.photographer_id = me` (photographers only; anyone else → no rows). */
export function myShootsWhere(ctx: AuthContext): SQL {
  if (ctx.role !== "photographer" || ctx.userId === null || ctx.isSystem) return sql`1 = 0`;
  return eq(jobs.photographerId, ctx.userId);
}

/** The actor's visible jobs, narrowed to "My shoots" when `scope === "mine"`. */
export function scopedJobsWhere(ctx: AuthContext, scope: ViewScope | null): SQL {
  return (scope === "mine" ? and(visibleJobsWhere(ctx), myShootsWhere(ctx)) : visibleJobsWhere(ctx)) as SQL;
}

export interface MetricScope {
  /** "org" = every job of the organisation; "visible" = `visibleJobsWhere(ctx)` (+ `extra`). */
  metric: "org" | "visible";
  extra?: SQL;
}

/**
 *   hasBusinessView ∧ scope = business → { metric: "org" }
 *   scope = mine                       → { metric: "visible", extra: myShootsWhere }
 *   otherwise (null)                   → { metric: "visible" }
 */
export function resolveMetricScope(ctx: AuthContext, scope: ViewScope | null): MetricScope {
  if (scope === "business" && hasBusinessView(ctx)) return { metric: "org" };
  if (scope === "mine") return { metric: "visible", extra: myShootsWhere(ctx) };
  return { metric: "visible" };
}

/** Cookie options for `POST /api/me/scope` (not audited: a UI preference). */
export const VIEW_SCOPE_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  maxAge: 365 * 24 * 60 * 60,
};
