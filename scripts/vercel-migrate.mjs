// `vercel-build` step 1: apply ./drizzle to the production database before
// `next build`. On Vercel, DIRECT_URL (Supabase session pooler) is a project
// env var; when it is absent (preview without a database, local builds) the
// step is skipped instead of failing. The URL is never printed.
import { spawnSync } from "node:child_process";

if (!process.env.DIRECT_URL?.trim()) {
  process.stdout.write("vercel-build: DIRECT_URL is not set — skipping drizzle-kit migrate\n");
  process.exit(0);
}
process.stdout.write("vercel-build: drizzle-kit migrate\n");
const result = spawnSync("npx", ["drizzle-kit", "migrate"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
