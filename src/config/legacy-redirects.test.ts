/**
 * Old addresses keep working (docs/SIMPLIFICATION-PLAN.md §3 "Redirects"): every pre-simplification path
 * 307s to its simple replacement, and no redirect shadows a canonical route. The conditional ones
 * (/insights/analytics|bottlenecks|reports → /editors, /projects → /jobs while Advanced tools is off) live
 * in the pages (`redirectUnlessAdvanced`), /workspace/my in the proxy, so they are absent here on purpose.
 * LEGACY_FALLBACK_REDIRECTS then catch every UNKNOWN child of the old Team / Insights sections (never a 404).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import nextConfig, { LEGACY_FALLBACK_REDIRECTS, LEGACY_REDIRECTS } from "../../next.config";

/** The matcher Next itself compiles `redirects()` sources with (untyped vendored copy). */
const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as { pathToRegexp: (source: string) => RegExp };

const CANONICAL = [
  "/home",
  "/my-jobs",
  "/jobs",
  "/jobs/new",
  "/jobs/:id",
  "/calendar",
  "/editors",
  "/editors/:id",
  "/clients",
  "/clients/:id",
  "/settings/studio",
  "/settings/people",
  "/settings/shoot-types",
  "/settings/account",
  "/settings/history",
  "/settings/workflows",
  "/settings/automations",
  "/workspace/kanban",
  "/workspace/timeline",
  "/insights/analytics",
  "/projects",
  "/portal",
];

describe("legacy route redirects (next.config.ts)", () => {
  it("sends every old path to its plan §3 replacement with a temporary redirect", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    // Exact addresses first (they carry their :id), the section fallbacks after them.
    expect(redirects.map((r) => ({ source: r.source, destination: r.destination }))).toEqual([...LEGACY_REDIRECTS, ...LEGACY_FALLBACK_REDIRECTS]);
    for (const rule of redirects) expect("permanent" in rule ? rule.permanent : undefined, rule.source).toBe(false);
    const bySource = new Map(LEGACY_REDIRECTS.map((r) => [r.source, r.destination]));
    const expected: Record<string, string> = {
      "/dashboard": "/home",
      "/workspace/all": "/jobs",
      "/workspace/all-work": "/jobs",
      "/workspace/team": "/jobs",
      "/workspace/team-work": "/jobs",
      "/workspace/my-work": "/jobs",
      "/workspace/calendar": "/calendar",
      "/team/editors": "/editors",
      "/team/editors/:id": "/editors/:id",
      "/team/photographers": "/settings/people",
      "/team/photographers/:id": "/settings/people",
      "/team/users/:id": "/editors/:id",
      "/team/workloads": "/editors",
      "/team/performance": "/editors",
      "/activity": "/settings/history",
      "/settings/organisation": "/settings/studio",
      "/settings/users": "/settings/people",
      "/settings/users/:id": "/settings/people",
      "/settings/job-types": "/settings/shoot-types",
      "/settings/profile": "/settings/account",
      "/settings/appearance": "/settings/account",
      "/settings/notifications": "/settings/account",
    };
    expect(Object.fromEntries(bySource)).toEqual(expected);
  });

  it("never shadows a canonical route, and every destination is a canonical route", () => {
    const sources = LEGACY_REDIRECTS.map((r) => r.source);
    for (const canonical of CANONICAL) expect(sources, canonical).not.toContain(canonical);
    for (const { destination } of LEGACY_REDIRECTS) expect(CANONICAL, destination).toContain(destination);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("leaves the conditional and edge-handled paths to the pages / proxy", () => {
    const sources = LEGACY_REDIRECTS.map((r) => r.source);
    for (const p of ["/workspace/my", "/insights/bottlenecks", "/insights/reports", "/insights/analytics", "/projects"]) expect(sources).not.toContain(p);
  });

  it("fallbacks: unknown children of /insights and /team go to Editors, the three Advanced Insights pages are left to their server-side gate", () => {
    const matches = (path: string) => LEGACY_FALLBACK_REDIRECTS.filter((r) => pathToRegexp(r.source).test(path)).map((r) => r.destination);
    for (const p of ["/insights", "/insights/nope", "/insights/analytics/deep", "/insights/reportsx", "/team", "/team/anything/deeper", "/team/users/x"]) {
      expect(matches(p), p).toEqual(["/editors"]);
    }
    for (const p of ["/insights/analytics", "/insights/bottlenecks", "/insights/reports", "/editors", "/jobs", "/settings/people"]) expect(matches(p), p).toEqual([]);
    for (const { destination } of LEGACY_FALLBACK_REDIRECTS) expect(CANONICAL).toContain(destination);
  });
});
