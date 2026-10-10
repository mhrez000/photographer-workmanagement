/**
 * `npm run db:reset` — DEV ONLY, LOCAL PGlite ONLY.
 *
 * Deletes the PGlite data dir (PGLITE_DATA_DIR, default ./data/pglite — the
 * only way history ever disappears), then runs db:migrate → db:seed →
 * db:verify. Refuses when NODE_ENV=production or when DATABASE_URL is set
 * (it never touches a remote database). Stop `npm run dev` first: PGlite
 * allows one process per data dir.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.env.NODE_ENV === "production") {
  process.stderr.write("db:reset refuses to run in production.\n");
  process.exit(1);
}
if (process.env.DATABASE_URL?.trim()) {
  process.stderr.write("db:reset refuses to run while DATABASE_URL is set (it only resets the local PGlite database).\n");
  process.exit(1);
}

const raw = process.env.PGLITE_DATA_DIR?.trim() || "./data/pglite";
if (raw === ":memory:" || raw.startsWith("memory://")) {
  process.stderr.write("db:reset: PGLITE_DATA_DIR is in-memory; nothing to reset.\n");
  process.exit(1);
}
const dataDir = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
const projectRoot = path.resolve(process.cwd());
if (!dataDir.startsWith(projectRoot + path.sep)) {
  process.stderr.write(`db:reset: refusing to delete ${dataDir} (outside the project directory).\n`);
  process.exit(1);
}

if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write(`db:reset: removed ${path.relative(process.cwd(), dataDir)}\n`);
}

const run = (script: string) => {
  process.stdout.write(`db:reset: npm run ${script}\n`);
  execSync(`npm run ${script}`, { stdio: "inherit", env: { ...process.env, PGLITE_DATA_DIR: dataDir, DATABASE_URL: "" } });
};

run("db:migrate");
run("db:seed");
run("db:verify");

process.stdout.write("db:reset: done\n");
