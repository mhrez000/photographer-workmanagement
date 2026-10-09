/**
 * Hosted demo build step (Vercel `vercel-build`).
 *
 * 1. Seeds a fresh demo database at data/demo.db through the real services
 *    (src/db/reset.ts: drizzle-kit push → triggers → seed → verify).
 * 2. Checkpoints the WAL and switches the file to rollback-journal mode, so the
 *    single file is complete and can be copied to /tmp at runtime.
 * 3. Writes data/.session-secret when SESSION_SECRET is not configured, so a
 *    one-click import still gets a random per-deployment signing secret.
 *
 * Run locally with: node scripts/build-demo-db.mjs
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = process.cwd();
const demoPath = path.join(root, "data", "demo.db");
const secretPath = path.join(root, "data", ".session-secret");
fs.mkdirSync(path.dirname(demoPath), { recursive: true });

const env = { ...process.env, DATABASE_PATH: demoPath, NODE_ENV: "development" };
delete env.VERCEL; // the seed must write to data/demo.db, not the runtime /tmp path
if (!env.SESSION_SECRET || env.SESSION_SECRET.trim().length < 32) {
  env.SESSION_SECRET = randomBytes(32).toString("hex"); // seed-time only; never persisted from here
}

console.log("build-demo-db: seeding", path.relative(root, demoPath));
execSync("npx tsx src/db/reset.ts", { stdio: "inherit", env });

const db = new Database(demoPath);
db.pragma("wal_checkpoint(TRUNCATE)");
db.pragma("journal_mode = DELETE");
const jobs = db.prepare("select count(*) as n from jobs").get();
db.close();
for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${demoPath}${suffix}`, { force: true });
console.log(`build-demo-db: ${jobs.n} jobs, ${(fs.statSync(demoPath).size / 1024 / 1024).toFixed(1)} MB`);

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.trim().length < 32) {
  fs.writeFileSync(secretPath, randomBytes(48).toString("hex"), { mode: 0o600 });
  console.log("build-demo-db: SESSION_SECRET not set — generated a per-deployment secret (data/.session-secret)");
}
