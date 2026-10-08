/**
 * `npm run db:reset` — DEV ONLY.
 *
 * Deletes the SQLite file (the only way history ever disappears), recreates
 * the schema with drizzle-kit push, installs the integrity triggers and
 * seeds demo data. Refuses to run when NODE_ENV=production.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.env.NODE_ENV === "production") {
  process.stderr.write("db:reset refuses to run in production.\n");
  process.exit(1);
}

const raw = process.env.DATABASE_PATH?.trim() || "./data/app.db";
if (raw === ":memory:") {
  process.stderr.write("db:reset: DATABASE_PATH is :memory:; nothing to delete.\n");
  process.exit(1);
}
const filePath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);

for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const target = `${filePath}${suffix}`;
  if (fs.existsSync(target)) {
    fs.rmSync(target, { force: true });
    process.stdout.write(`db:reset: removed ${path.relative(process.cwd(), target)}\n`);
  }
}

const run = (script: string) => {
  process.stdout.write(`db:reset: npm run ${script}\n`);
  execSync(`npm run ${script}`, { stdio: "inherit", env: { ...process.env, DATABASE_PATH: filePath } });
};

run("db:push");
run("db:guard");
run("db:seed");

process.stdout.write("db:reset: done\n");
