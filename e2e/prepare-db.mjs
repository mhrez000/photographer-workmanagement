// `npm run e2e:prepare` — reset the dedicated e2e database (PGlite data dir
// data/pglite-e2e) with the same delete → migrate → seed → verify pipeline as
// `npm run db:reset`, but never touching data/pglite. Cross-platform replacement
// for `PGLITE_DATA_DIR=./data/pglite-e2e tsx src/db/reset.ts` (cmd.exe has no inline env).
import { spawnSync } from "node:child_process";

// The e2e specs are written against the large fixture (SIMPLIFICATION-PLAN §8: "the large demo stays as a test fixture").
const env = { ...process.env, PGLITE_DATA_DIR: "./data/pglite-e2e", DATABASE_URL: "", SEED_PROFILE: process.env.SEED_PROFILE ?? "full" };
const result = spawnSync("npx", ["tsx", "src/db/reset.ts"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
