/**
 * Static guard for the REST surface: every `src/app/api/**\/route.ts` exports
 * all five methods, so an unsupported method is our JSON 405
 * (`methodNotAllowed`) or JSON 404 (`notFoundRoute`) — never Next's empty 405.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
