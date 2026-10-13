import "server-only";
import { forbidden, notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import type { DbLike } from "@/db";
import { ADVANCED_FEATURE_META, type Action, type AdvancedFeature } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { advancedToolsOn, can } from "@/server/auth/permissions";
import { getOptionalContext } from "@/server/auth/session";
import { ForbiddenError, NotFoundError } from "@/server/errors";

/**
 * Helpers for Server Component pages under `src/app/(app)`.
 *
 *   const { ctx, db } = await pageContext();
 *   guard(ctx, "analytics.view");                       // 403 page if denied
 *   requireAdvanced(ctx, "analytics");                  // 404 page while Advanced tools is off
 *   const detail = await load(() => getJobDetail(db, ctx, id)); // 404 / 403 mapped
 *
 * UI hiding is never the security boundary: every page re-checks here, and
 * every query/service re-checks again.
 */

export interface PageContext {
  ctx: AuthContext;
  db: DbLike;
}

/** Staff landing pages (docs/SIMPLIFICATION-PLAN.md §3): editors live on My jobs, photographers on Home. */
export const STAFF_HOME_PATH = "/home";
export const EDITOR_HOME_PATH = "/my-jobs";
export const PORTAL_HOME_PATH = "/portal";

/** Where `ctx` lands after sign-in (plan §3). */
export function homePathFor(ctx: Pick<AuthContext, "role">): string {
  if (ctx.role === "client") return PORTAL_HOME_PATH;
  return ctx.role === "editor" ? EDITOR_HOME_PATH : STAFF_HOME_PATH;
}

/** Current STAFF context, or redirect to /login (signed out) or /portal (client users, docs/ROLES.md §7.8). */
export async function pageContext(): Promise<PageContext> {
  const ctx = await getOptionalContext();
  if (!ctx) redirect("/login?expired=1");
  if (ctx.role === "client") redirect(PORTAL_HOME_PATH);
  return { ctx, db: getDb() };
}

/** Current CLIENT context for /portal pages, or redirect to /login (signed out) or the staff landing page. */
export async function portalPageContext(): Promise<PageContext> {
  const ctx = await getOptionalContext();
  if (!ctx) redirect("/login?expired=1");
  if (ctx.role !== "client") redirect(homePathFor(ctx));
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

/* ------------------------------------------------------------------ */
/*  Advanced tools gates (docs/SIMPLIFICATION-PLAN.md §8)              */
/* ------------------------------------------------------------------ */

/** The studio's Advanced tools switch, as the context carries it. */
export function advancedEnabled(ctx: Pick<AuthContext, "settings">): boolean {
  return advancedToolsOn(ctx);
}

/**
 * Hidden pages are blocked on the server, not only removed from the menu: renders the 404 page when the
 * organisation has Advanced tools off. The feature's own permission (`guard(ctx, "analytics.view")`,
 * `workflow.manage`, …) is checked separately by the page as before.
 */
export function requireAdvanced(ctx: AuthContext, feature: AdvancedFeature): void {
  if (!advancedEnabled(ctx)) notFound();
  if (!can(ctx, "advanced.view", { feature })) notFound();
}

/**
 * For old addresses that a studio with Advanced tools on may still use (/insights/*, /projects): 307
 * to the simple replacement while the switch is off (`/editors`, `/jobs`), else continue.
 */
export function redirectUnlessAdvanced(ctx: AuthContext, feature: AdvancedFeature, to: string): void {
  if (!advancedEnabled(ctx) || !can(ctx, "advanced.view", { feature })) redirect(to);
}

/**
 * `pageContext()` + `redirectUnlessAdvanced()` for the PAGE (and nested layout) of an Advanced route.
 * Next renders a segment's layout and page in parallel, so a gate in `layout.tsx` alone does not stop
 * the page from loading all of its data before the 307 goes out (/projects took ~20 s while off). Every
 * Advanced page therefore calls this FIRST, before any query, and keeps the layout gate for the real status.
 */
export async function advancedPageContext(feature: AdvancedFeature, to: string): Promise<PageContext> {
  const page = await pageContext();
  redirectUnlessAdvanced(page.ctx, feature, to);
  return page;
}

/**
 * Route-handler twin of `requireAdvanced`: throws NotFoundError (→ 404 JSON through `handle`) while
 * Advanced tools is off. Use it at the top of the hidden APIs (saved views, dashboard layout, timer,
 * bulk UI endpoints, automations, workflows editor, workloads, analytics, reports, timeline, kanban).
 * Services called INTERNALLY (deactivate-user reassignment uses the bulk reassign service directly, the
 * delivery step shares links, …) are never gated: only the HTTP surface is.
 */
export function requireAdvancedApi(ctx: AuthContext, feature: AdvancedFeature): void {
  if (!advancedEnabled(ctx) || !can(ctx, "advanced.view", { feature })) {
    throw new NotFoundError("Page", `${ADVANCED_FEATURE_META[feature].label} is an Advanced tool; turn on Advanced tools in Settings → Studio`);
  }
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
