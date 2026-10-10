/**
 * Remote (Supabase) database commands. Connection strings come ONLY from
 * .env.supabase (scripts/remote-env.ts); their values are never printed.
 *
 *   npm run db:migrate:remote            drizzle-kit migrate against DIRECT_URL
 *   npm run db:seed:remote [-- --wipe]   seed a fresh in-memory PGlite through the
 *                                        real seed, copy every table to Supabase in
 *                                        ONE transaction, then verify the remote
 *   npm run db:verify:remote             verifyDerived() against DIRECT_URL
 */
import { spawnSync } from "node:child_process";
import { closeDb, createPostgresClient, createPostgresDb, openPglite } from "../src/db/index";
import { describeUrl, loadRemoteEnv } from "./remote-env";
import { assertSchema, copyDatabase, nonEmptyTables, tableCounts, TargetNotEmptyError } from "./remote-copy";

const out = (line: string) => process.stdout.write(`${line}\n`);

async function migrate(): Promise<number> {
  const env = loadRemoteEnv();
  out(`db:migrate:remote — applying ./drizzle to ${describeUrl(env.directUrl)}`);
  // drizzle.config.ts reads DIRECT_URL (fallback DATABASE_URL). On Windows npx
  // is a .cmd shim → needs a shell; pass ONE command string (no args array).
  const options = { stdio: "inherit" as const, env: { ...process.env, DIRECT_URL: env.directUrl } };
  const result =
    process.platform === "win32"
      ? spawnSync("npx drizzle-kit migrate", { ...options, shell: true })
      : spawnSync("npx", ["drizzle-kit", "migrate"], options);
  return result.status ?? 1;
}

async function verifyRemote(directUrl: string): Promise<boolean> {
  const { verifyDerived } = await import("../src/db/verify");
  const { db, client } = createPostgresDb(directUrl, { max: 1 });
  try {
    const report = await verifyDerived(db);
    out(`verify (remote): ${report.jobsChecked} jobs checked, ${report.drift.length} drift, ${report.structural.length} structural issues`);
    for (const d of report.drift.slice(0, 20)) out(`  drift ${d.jobId} ${d.column}: stored=${JSON.stringify(d.stored)} derived=${JSON.stringify(d.derived)}`);
    for (const s of report.structural.slice(0, 20)) out(`  invariant ${s.check} ${s.jobId ?? "-"}: ${s.detail}`);
    return report.ok;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function seed(wipe: boolean): Promise<number> {
  const env = loadRemoteEnv();
  // The seed must run on the LOCAL in-memory database: make sure nothing in this
  // process picks the remote URL up through getDb().
  delete process.env.DATABASE_URL;
  const { loadSeedEnv, seedDatabase } = await import("../src/db/seed");
  loadSeedEnv();

  // Refuse BEFORE the ~45 s local seed when the target is not migrated or not empty.
  const probe = createPostgresClient(env.directUrl, { max: 1 });
  try {
    await assertSchema(probe);
    const nonEmpty = await nonEmptyTables(probe);
    if (nonEmpty.length > 0 && !wipe) {
      process.stderr.write(`db:seed:remote: ${new TargetNotEmptyError(nonEmpty).message}
`);
      return 1;
    }
  } finally {
    await probe.end({ timeout: 5 });
  }

  out("db:seed:remote — seeding a fresh in-memory PGlite through the real services");
  const local = openPglite("memory://");
  try {
    await local.ready;
    const ok = await seedDatabase(local.db, { log: out });
    if (!ok) {
      process.stderr.write("db:seed:remote: the local seed failed; nothing was copied.\n");
      return 1;
    }
    out(`db:seed:remote — copying to ${describeUrl(env.directUrl)}${wipe ? " (--wipe)" : ""}`);
    const target = createPostgresClient(env.directUrl, { max: 1 });
    try {
      const copied = await copyDatabase(local.db, target, { wipe, log: out });
      out(`db:seed:remote — copied ${copied.totalRows} rows in ${copied.tables.length} tables${copied.wiped ? " (target wiped first)" : ""}`);
      // Independent re-count on the target after COMMIT: must equal the local seed exactly.
      const remote = await tableCounts(target);
      const mismatches = copied.tables.filter(({ table, rows }) => remote.get(table) !== rows);
      out("db:seed:remote — row counts (local seed → remote):");
      for (const { table, rows } of copied.tables) {
        out(`  ${table.padEnd(24)} ${String(rows).padStart(6)} → ${String(remote.get(table) ?? "?").padStart(6)}${remote.get(table) === rows ? "" : "  MISMATCH"}`);
      }
      if (mismatches.length > 0) {
        process.stderr.write(`db:seed:remote: ${mismatches.length} table(s) differ between the local seed and the remote
`);
        return 1;
      }
    } catch (err) {
      if (err instanceof TargetNotEmptyError) {
        process.stderr.write(`db:seed:remote: ${err.message}\n`);
        return 1;
      }
      throw err;
    } finally {
      await target.end({ timeout: 5 });
    }
  } finally {
    await local.client.close();
  }
  return (await verifyRemote(env.directUrl)) ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "migrate":
      return migrate();
    case "seed":
      return seed(rest.includes("--wipe"));
    case "verify": {
      const env = loadRemoteEnv();
      out(`db:verify:remote — ${describeUrl(env.directUrl)}`);
      return (await verifyRemote(env.directUrl)) ? 0 : 1;
    }
    default:
      process.stderr.write("usage: tsx scripts/db-remote.ts <migrate | seed [--wipe] | verify>\n");
      return 2;
  }
}

main(process.argv.slice(2))
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (err: unknown) => {
    // Error messages from postgres-js never contain the connection string.
    process.stderr.write(`db-remote failed: ${err instanceof Error ? err.message : String(err)}\n`);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
