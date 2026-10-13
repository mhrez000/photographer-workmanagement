/**
 * Static guard for the REST surface: every `src/app/api/**\/route.ts` exports
 * all five methods, so an unsupported method is our JSON 405
 * (`methodNotAllowed`) or JSON 404 (`notFoundRoute`) — never Next's empty 405.
 *
 * Second guard (SIMPLIFICATION-PLAN §8): every route file whose path belongs to an Advanced-tools
 * feature reaches the gate — through the `_lib/route.ts` factories (which call `requireRouteContext`)
 * or by calling `requireRouteContext` itself — so a hidden API is a 404 while the switch is off.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADVANCED_FEATURE_META, ADVANCED_FEATURES, ADVANCED_JOB_SUBPATHS } from "@/lib/constants";

const API_DIR = path.resolve(import.meta.dirname, "..");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return e.name === "route.ts" && !full.includes(`${path.sep}_lib${path.sep}`) ? [full] : [];
  });
}

describe("API route files", () => {
  const files = routeFiles(API_DIR);

  it("finds the route tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files.map((f) => [path.relative(API_DIR, f).split(path.sep).join("/"), f]))("%s exports every HTTP method", (_rel, file) => {
    const src = fs.readFileSync(file, "utf8");
    const missing = METHODS.filter((m) => !new RegExp(`^export const ${m} = `, "m").test(src));
    expect(missing).toEqual([]);
  });
});

/** `src/app/api/kanban/drop/route.ts` → `/api/kanban/drop`; `[id]` → `:id`. */
function apiPathOf(file: string): string {
  const rel = path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
  return `/api/${rel}`.replace(/\/\[\.\.\.[^\]]+\]/g, "/*").replace(/\[([^\]]+)\]/g, ":$1");
}

function isAdvancedApiPath(apiPath: string): boolean {
  for (const key of ADVANCED_FEATURES) {
    for (const prefix of ADVANCED_FEATURE_META[key].apiPrefixes) {
      if (apiPath === prefix || apiPath.startsWith(`${prefix}/`)) return true;
    }
  }
  const m = /^\/api\/jobs\/:id\/([^/]+)$/.exec(apiPath);
  return m !== null && ADVANCED_JOB_SUBPATHS[m[1]] !== undefined;
}

/** The route imports one of the gated factories, or `requireRouteContext` itself, from `_lib/route`. */
const GATE_IMPORT_RE = /import\s*\{[^}]*\b(read|readBy|mutate|mutateById|requireRouteContext)\b[^}]*\}\s*from "@\/app\/api\/_lib\/route"/;

describe("Advanced-tools API gate coverage", () => {
  const gated = routeFiles(API_DIR).filter((f) => isAdvancedApiPath(apiPathOf(f)));

  it("covers the hidden features' routes", () => {
    const paths = gated.map(apiPathOf);
    expect(paths).toEqual(expect.arrayContaining(["/api/kanban", "/api/workloads", "/api/jobs/bulk/reassign", "/api/jobs/:id/timer", "/api/me/timer", "/api/automations/:id/dry-run"]));
    expect(paths).not.toContain("/api/jobs/simple");
    expect(paths).not.toContain("/api/dashboard");
  });

  it.each(gated.map((f) => [apiPathOf(f), f]))("%s reaches the Advanced gate", (_p, file) => {
    const src = fs.readFileSync(file, "utf8");
    // every method that is not a 405 stub must be built by a gated factory or call requireRouteContext
    const live = METHODS.filter((m) => !new RegExp(`^export const ${m} = methodNotAllowed\\(`, "m").test(src));
    expect(live.length).toBeGreaterThan(0);
    expect(GATE_IMPORT_RE.test(src)).toBe(true);
    // a bare requireContext() would skip the gate
    expect(src).not.toMatch(/\brequireContext\(\)/);
  });
});
