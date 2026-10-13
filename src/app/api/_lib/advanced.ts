/**
 * Advanced-tools gate for the REST surface (docs/SIMPLIFICATION-PLAN.md §8 "hidden pages are blocked on
 * the server, not just removed from the menu").
 *
 * Every `/api/*` path that belongs to a hidden feature — the `apiPrefixes` of `ADVANCED_FEATURE_META`
 * plus the per-job sub-paths of `ADVANCED_JOB_SUBPATHS` (`/api/jobs/:id/timer`, `/sessions`, `/pause`,
 * `/resume`, `/migrate-workflow`) — answers **404 JSON** while the organisation has Advanced tools off,
 * exactly like the hidden pages. The route factories in `./route.ts` call `gateAdvancedApi` right after
 * `requireContext()`, so a route under a gated prefix needs no code of its own; the few handlers that
 * build on `handle()` directly call it themselves. Only the HTTP surface is gated: services used
 * internally (deactivate-user reassignment, the delivery step's sharing, …) are untouched.
 */
import { ADVANCED_FEATURE_META, ADVANCED_FEATURES, ADVANCED_JOB_SUBPATHS, type AdvancedFeature } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { requireAdvancedApi } from "@/server/page";

const JOB_SUBPATH_RE = /^\/api\/jobs\/([^/]+)\/([^/]+)(?:\/|$)/;

/** `/api/jobs/simple` and `/api/jobs/bulk` are static segments, not job ids. */
const STATIC_JOB_SEGMENTS = new Set(["simple", "bulk", "by-number"]);

/**
 * The advanced feature that owns an `/api/*` pathname, or null for an always-available route.
 * Prefix match on `apiPrefixes` (`/api/kanban`, `/api/kanban/drop`, …) plus the per-job sub-paths.
 */
export function advancedFeatureForApiPath(pathname: string): AdvancedFeature | null {
  for (const key of ADVANCED_FEATURES) {
    for (const prefix of ADVANCED_FEATURE_META[key].apiPrefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return key;
    }
  }
  const m = JOB_SUBPATH_RE.exec(pathname);
  if (m && !STATIC_JOB_SEGMENTS.has(m[1])) {
    const feature = ADVANCED_JOB_SUBPATHS[m[2]];
    if (feature) return feature;
  }
  return null;
}

/** Pathname of a request (query string dropped). */
export function pathnameOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return req.url;
  }
}

/**
 * Throws `NotFoundError` (→ 404 JSON through `handle`) when `pathname` belongs to a hidden feature and
 * the organisation has Advanced tools off. A no-op for every other path.
 */
export function gateAdvancedApi(ctx: AuthContext, pathname: string): void {
  const feature = advancedFeatureForApiPath(pathname);
  if (feature) requireAdvancedApi(ctx, feature);
}
