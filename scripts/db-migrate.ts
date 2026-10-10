/**
 * `npm run db:migrate` — applies the committed ./drizzle migrations (schema +
 * integrity triggers) to the LOCAL PGlite database (PGLITE_DATA_DIR, default
 * ./data/pglite). Refuses when DATABASE_URL is set; remote databases use
 * `npm run db:migrate:remote`.
 */
import { closeDb, dbReady, resolvePgliteDataDir } from "../src/db/index";

async function main(): Promise<number> {
  if (process.env.DATABASE_URL?.trim()) {
    process.stderr.write("db:migrate is local-only (PGlite) and refuses to run while DATABASE_URL is set. Use npm run db:migrate:remote.\n");
    return 1;
  }
  const dir = resolvePgliteDataDir();
  await dbReady(); // opening the default PGlite database applies the migrations
  process.stdout.write(`db:migrate — migrations applied to PGlite at ${dir}\n`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`db:migrate failed: ${err instanceof Error ? err.message : String(err)}\n`);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
