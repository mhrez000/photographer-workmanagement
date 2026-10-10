import "server-only";
import { forbidden, notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import type { DbLike } from "@/db";
import type { Action } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { can } from "@/server/auth/permissions";
import { getOptionalContext } from "@/server/auth/session";
import { ForbiddenError, NotFoundError } from "@/server/errors";

/**
 * Helpers for Server Component pages under `src/app/(app)`.
 *
 *   const { ctx, db } = await pageContext();
 *   guard(ctx, "analytics.view");                       // 403 page if denied
 *   const detail = await load(() => getJobDetail(db, ctx, id)); // 404 / 403 mapped
 *
 * UI hiding is never the security boundary: every page re-checks here, and
 * every query/service re-checks again.
 */

export interface PageContext {
  ctx: AuthContext;
  db: DbLike;
}

/** Current STAFF context, or redirect to /login (signed out) or /portal (client users, docs/ROLES.md §7.8). */
export async function pageContext(): Promise<PageContext> {
  const ctx = await getOptionalContext();
  if (!ctx) redirect("/login?expired=1");
  if (ctx.role === "client") redirect("/portal");
  return { ctx, db: getDb() };
}

/** Current CLIENT context for /portal pages, or redirect to /login (signed out) or /dashboard (staff). */
export async function portalPageContext(): Promise<PageContext> {
  const ctx = await getOptionalContext();
  if (!ctx) redirect("/login?expired=1");
  if (ctx.role !== "client") redirect("/dashboard");
  return { ctx, db: getDb() };
}

/** Renders the 403 page (src/app/forbidden.tsx) unless `ctx` may perform `action`. */
export function guard(ctx: AuthContext, action: Action, resource?: Parameters<typeof can>[2]): void {
  if (!can(ctx, action, resource as never)) forbidden();
}

/** True when the actor may perform `action` (for conditional UI). */
export function allowed(ctx: AuthContext, action: Action, resource?: Parameters<typeof can>[2]): boolean {
  return can(ctx, action, resource as never);
}

/** Awaits a query, mapping NotFoundError → 404 page and ForbiddenError → 403 page. */
export async function load<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) forbidden();
    throw err;
  }
}

/** Reads a single string search param (first value when repeated). */
export function param(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Reads a repeatable search param as an array. */
export function params(sp: Record<string, string | string[] | undefined>, key: string): string[] {
  const v = sp[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : v.split(",").filter(Boolean);
}
