/**
 * DATA-01: `scripts/vercel-migrate.mjs` (the `vercel-build` step that runs `drizzle-kit migrate`) only migrates the live
 * database from a PRODUCTION deploy. A Preview build of a branch must never apply that branch's migrations to the one
 * shared database before merge (drizzle never re-runs an applied file, so a later edit would never arrive).
 * Only the "skip" paths are exercised: nothing here may ever reach a database.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(process.cwd(), "scripts/vercel-migrate.mjs");
/** A URL nothing listens on: if the script ever tried to migrate, it would fail (and the test with it). */
const UNREACHABLE = "postgres://nobody:nothing@127.0.0.1:1/none";

function run(env: Record<string, string | undefined>) {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !["VERCEL_ENV", "DIRECT_URL", "MIGRATE_ON_BUILD"].includes(key)) clean[key] = value;
  for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value;
  const res = spawnSync(process.execPath, [SCRIPT], { env: clean as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("vercel-build migrate step", () => {
  it("a Preview (or development) deploy skips migrating, even with DIRECT_URL set", () => {
    for (const target of ["preview", "development"]) {
      const res = run({ VERCEL_ENV: target, DIRECT_URL: UNREACHABLE });
      expect(res.status, target).toBe(0);
      expect(res.out).toContain(`VERCEL_ENV is "${target}" — skipping drizzle-kit migrate`);
      expect(res.out).not.toContain(UNREACHABLE);
    }
  });

  it("without DIRECT_URL it skips (local builds, previews without a database)", () => {
    const res = run({ VERCEL_ENV: "production" });
    expect(res.status).toBe(0);
    expect(res.out).toContain("DIRECT_URL is not set — skipping drizzle-kit migrate");
  });
});
