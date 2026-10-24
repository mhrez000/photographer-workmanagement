// `vercel-build` step 1: apply ./drizzle to the production database before
// `next build`. On Vercel, DIRECT_URL (Supabase session pooler) is a project
// env var; when it is absent (preview without a database, local builds) the
// step is skipped instead of failing. The URL is never printed.
//
// Only PRODUCTION deploys migrate (DATA-01). There is one database: a Preview
// build that migrated it would apply a branch's migrations to the live data
// before the code is merged — and drizzle never re-runs an applied file, so a
// later edit to that migration would silently never reach production. A
// preview that really needs it (its own database) sets MIGRATE_ON_BUILD=1.
import { spawnSync } from "node:child_process";

const target = process.env.VERCEL_ENV?.trim();
const forced = process.env.MIGRATE_ON_BUILD?.trim() === "1";
if (target && target !== "production" && !forced) {
  process.stdout.write(`vercel-build: VERCEL_ENV is "${target}" — skipping drizzle-kit migrate (production deploys only; MIGRATE_ON_BUILD=1 overrides)\n`);
  process.exit(0);
}
if (!process.env.DIRECT_URL?.trim()) {
  process.stdout.write("vercel-build: DIRECT_URL is not set — skipping drizzle-kit migrate\n");
  process.exit(0);
}
process.stdout.write("vercel-build: drizzle-kit migrate\n");
const result = spawnSync("npx", ["drizzle-kit", "migrate"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
