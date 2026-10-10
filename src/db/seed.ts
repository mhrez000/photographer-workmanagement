/**
 * `npm run db:seed` — demo data (ARCHITECTURE.md §12) into the LOCAL
 * database (PGlite; or DATABASE_URL when a script sets it on purpose).
 *
 *   1. opens the DB via src/db/index.ts (PGlite auto-applies the migrations,
 *      including the integrity triggers)
 *   2. drives the REAL services under a movable clock (src/db/seed/*)
 *   3. runs the sweep at real now, then verifyDerived(): any drift or
 *      structural issue — or a missed spec §39 minimum — exits non-zero.
 *
 * `seedDatabase(db, …)` is the reusable core: `npm run db:seed:remote`
 * (scripts/db-remote.ts) runs it against a fresh in-memory PGlite and then
 * copies the result to Supabase.
 *
 * "Today" of the generated history is the real current date at seed time.
 */
import fs from "node:fs";
import path from "node:path";
import { count } from "drizzle-orm";
import type { Db } from "./index";

export interface SeedDatabaseOptions {
  now?: Date;
  log?: (line: string) => void;
}

/** Runs the demo seed + report + verify on `db`. Resolves true when everything passed. */
export async function seedDatabase(db: Db, options: SeedDatabaseOptions = {}): Promise<boolean> {
  const out = options.log ?? (() => undefined);
  const started = Date.now();
  const { organisations } = await import("./schema");
  const { runSeed } = await import("./seed/index");
  const { buildReport } = await import("./seed/summary");
  const { verifyDerived } = await import("./verify");

  const [existing] = await db.select({ n: count() }).from(organisations);
  if ((existing?.n ?? 0) > 0) {
    process.stderr.write("db:seed: organisations already exist — run `npm run db:reset` for a fresh database.\n");
    return false;
  }

  const now = options.now ?? new Date();
  out(`db:seed — generating history up to ${now.toISOString()}`);
  const result = await runSeed(db, { now, log: out });
  out(`db:seed — ${result.stepsRun} queued steps executed; ${result.skipped.length} skipped`);
  for (const s of result.skipped.slice(0, 20)) out(`  skipped: ${s}`);
  out(
    `db:seed — timings: ${Object.entries(result.durationsMs)
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
      .join(", ")}`,
  );
  for (const sweep of result.finalSweeps) {
    out(
      `db:seed — final sweep ${sweep.organisationId}: overdue flagged ${sweep.overdueJobIds.length}, review overdue ${sweep.reviewOverdueJobIds.length}, band changes ${sweep.bandChanges.length}, automations ${sweep.automations.processed}`,
    );
  }
  out(`db:seed — notifications marked read: ${result.notificationsRead.read} of ${result.notificationsRead.total}`);

  const report = await buildReport(db, result.northlightId, now.getTime());
  for (const line of report.lines) out(line);
  for (const c of report.checks) out(`  ${c.ok ? "ok  " : c.hard ? "FAIL" : "warn"} ${c.label}: ${c.detail}`);

  const integrity = await verifyDerived(db);
  out(`db:seed — verify: ${integrity.jobsChecked} jobs checked, ${integrity.drift.length} drift, ${integrity.structural.length} structural issues`);
  for (const d of integrity.drift.slice(0, 20)) out(`  drift ${d.jobId} ${d.column}: stored=${JSON.stringify(d.stored)} derived=${JSON.stringify(d.derived)}`);
  for (const s of integrity.structural.slice(0, 20)) out(`  invariant ${s.check} ${s.jobId ?? "-"}: ${s.detail}`);
  out(`db:seed — done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (!integrity.ok) {
    process.stderr.write("db:seed: verifyDerived() reported drift — aborting with a non-zero exit.\n");
    return false;
  }
  if (!report.ok) {
    process.stderr.write("db:seed: spec §39 minimums not met.\n");
    return false;
  }
  return true;
}

/** Loads .env (never .env.supabase) and a throwaway SESSION_SECRET for the session module. */
export function loadSeedEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // A malformed .env is reported by the app itself; the seed only needs the defaults below.
    }
  }
  // The seed never signs cookies, but the session module requires a secret at load time.
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.trim().length < 32) {
    process.env.SESSION_SECRET = "seed-only-secret-not-used-for-cookies-0000000000";
  }
}

/* ------------------------------------------------------------------ */
/*  CLI entry: `tsx src/db/seed.ts`                                     */
/* ------------------------------------------------------------------ */

const isDirectRun =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /[\\/]seed\.(ts|js|mts|mjs|cjs)$/.test(process.argv[1]);

if (isDirectRun) {
  loadSeedEnv();
  void (async () => {
    const { getDb, dbReady, closeDb } = await import("./index");
    try {
      await dbReady();
      const ok = await seedDatabase(getDb(), { log: (line) => process.stdout.write(`${line}\n`) });
      process.exitCode = ok ? 0 : 1;
    } catch (err) {
      process.stderr.write(`db:seed failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
  })();
}
