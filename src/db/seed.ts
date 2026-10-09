/**
 * `npm run db:seed` — demo data (ARCHITECTURE.md §12).
 *
 *   1. opens the DB via src/db/index.ts (which installs the guards)
 *   2. drives the REAL services under a movable clock (src/db/seed/*)
 *   3. runs the sweep at real now, then verifyDerived(): any drift or
 *      structural issue — or a missed spec §39 minimum — exits non-zero.
 *
 * "Today" of the generated history is the real current date at seed time.
 */
import fs from "node:fs";
import path from "node:path";

function loadEnv(): void {
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

async function main(): Promise<number> {
  loadEnv();
  const started = Date.now();
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const { db, sqlite } = await import("./index");
  const { runSeed } = await import("./seed/index");
  const { buildReport } = await import("./seed/summary");
  const { verifyDerived } = await import("./verify");

  const now = new Date();
  out(`db:seed — generating history up to ${now.toISOString()}`);
  sqlite.pragma("synchronous = OFF");
  const result = await runSeed(db, sqlite, { now, log: out });
  sqlite.pragma("synchronous = NORMAL");
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

  const report = buildReport(db, sqlite, result.northlightId, now.getTime());
  for (const line of report.lines) out(line);
  for (const c of report.checks) out(`  ${c.ok ? "ok  " : c.hard ? "FAIL" : "warn"} ${c.label}: ${c.detail}`);

  const integrity = verifyDerived(sqlite);
  out(`db:seed — verify: ${integrity.jobsChecked} jobs checked, ${integrity.drift.length} drift, ${integrity.structural.length} structural issues`);
  for (const d of integrity.drift.slice(0, 20)) out(`  drift ${d.jobId} ${d.column}: stored=${JSON.stringify(d.stored)} derived=${JSON.stringify(d.derived)}`);
  for (const s of integrity.structural.slice(0, 20)) out(`  invariant ${s.check} ${s.jobId ?? "-"}: ${s.detail}`);
  out(`db:seed — done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (!integrity.ok) {
    process.stderr.write("db:seed: verifyDerived() reported drift — aborting with a non-zero exit.\n");
    return 1;
  }
  if (!report.ok) {
    process.stderr.write("db:seed: spec §39 minimums not met.\n");
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`db:seed failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
