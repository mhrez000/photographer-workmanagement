import type { NextConfig } from "next";

/**
 * Old addresses keep working (docs/SIMPLIFICATION-PLAN.md §3 "Old links keep working"). Temporary
 * (307) so the canonical routes stay free to move again. Static redirects cannot read the studio's
 * Advanced tools switch, so the two conditional ones live server-side instead:
 *   /insights/*  → /editors unless Advanced   (`redirectUnlessAdvanced(ctx, feature, "/editors")` in the page)
 *   /projects    → /jobs    unless Advanced   (`redirectUnlessAdvanced(ctx, "projects", "/jobs")`)
 *   /workspace/my → /jobs for photographers, /my-jobs for editors (src/proxy.ts reads the role claim)
 */
export const LEGACY_REDIRECTS: readonly { source: string; destination: string }[] = [
  { source: "/dashboard", destination: "/home" },
  { source: "/workspace/all", destination: "/jobs" },
  { source: "/workspace/all-work", destination: "/jobs" },
  { source: "/workspace/team", destination: "/jobs" },
  { source: "/workspace/team-work", destination: "/jobs" },
  { source: "/workspace/my-work", destination: "/jobs" },
  { source: "/workspace/calendar", destination: "/calendar" },
  { source: "/team/editors", destination: "/editors" },
  { source: "/team/editors/:id", destination: "/editors/:id" },
  { source: "/team/photographers", destination: "/settings/people" },
  { source: "/team/photographers/:id", destination: "/settings/people" },
  { source: "/team/users/:id", destination: "/editors/:id" },
  { source: "/team/workloads", destination: "/editors" },
  { source: "/team/performance", destination: "/editors" },
  { source: "/activity", destination: "/settings/history" },
  { source: "/settings/organisation", destination: "/settings/studio" },
  { source: "/settings/users", destination: "/settings/people" },
  { source: "/settings/users/:id", destination: "/settings/people" },
  { source: "/settings/job-types", destination: "/settings/shoot-types" },
  { source: "/settings/profile", destination: "/settings/account" },
  { source: "/settings/appearance", destination: "/settings/account" },
  { source: "/settings/notifications", destination: "/settings/account" },
];

/**
 * Fallbacks for unknown legacy children (reviewer finding E17 follow-up: "unknown legacy children never
 * 404"): anything under the old Team and Insights sections that no entry above names goes to Editors.
 * The three Insights pages a studio with Advanced tools on still uses (exactly /insights/analytics,
 * /insights/bottlenecks, /insights/reports) are excluded by a lookahead, so their server-side gate keeps
 * deciding; anything deeper under them is unknown and goes to Editors too.
 * Kept apart from LEGACY_REDIRECTS because these sources are patterns, not addresses (e2e iterates the
 * list above literally).
 */
export const LEGACY_FALLBACK_REDIRECTS: readonly { source: string; destination: string }[] = [
  { source: "/insights", destination: "/editors" },
  { source: "/insights/:rest((?!analytics$|bottlenecks$|reports$).*)", destination: "/editors" },
  { source: "/team/:rest*", destination: "/editors" }, // `:rest*` also matches the bare /team
];

const nextConfig: NextConfig = {
  // Authenticated, per-request data on every page: keep the classic dynamic
  // rendering model (no Cache Components / PPR) so DB reads are always fresh.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // PGlite (local dev / e2e) loads its WASM + data bundle from its package
  // directory at runtime, so it must not be bundled; same for the postgres driver.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  // Optional build-time session secret (src/server/auth/session.ts fallback).
  outputFileTracingIncludes: {
    "/*": ["./data/.session-secret"],
    "/**": ["./data/.session-secret"],
  },
  // forbidden() + src/app/forbidden.tsx for permission-denied pages.
  experimental: { authInterrupts: true },
  async redirects() {
    // Exact legacy addresses first (they carry their :id), then the section fallbacks.
    return [...LEGACY_REDIRECTS, ...LEGACY_FALLBACK_REDIRECTS].map((r) => ({ ...r, permanent: false }));
  },
};

export default nextConfig;
