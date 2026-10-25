// `npm run e2e:prepare` — reset the dedicated e2e database (PGlite data dir
// data/pglite-e2e) with the same delete → migrate → seed → verify pipeline as
// `npm run db:reset`, but never touching data/pglite. Cross-platform replacement
// for `PGLITE_DATA_DIR=./data/pglite-e2e tsx src/db/reset.ts` (cmd.exe has no inline env).
import { spawnSync } from "node:child_process";

// The e2e specs are written against the SMALL demo (SIMPLIFICATION-PLAN §8: 1 owner, 1 extra
// photographer, 3 editors, 2 clients, ~20 jobs, Advanced tools off). Every spec creates the jobs and
// users it asserts on, so the profile only has to provide the roster. `SEED_PROFILE=full` still works.
// Accounts: the e2e studio is NOT flagged as the demo studio (SEED_DEMO=off) — the specs invite people and reset
// passwords there, which a demo studio refuses. Run with SEED_DEMO=on to exercise the demo panel end to end.
const env = { ...process.env, PGLITE_DATA_DIR: "./data/pglite-e2e", DATABASE_URL: "", SEED_PROFILE: process.env.SEED_PROFILE ?? "small", SEED_DEMO: process.env.SEED_DEMO ?? "off" };
const result = spawnSync("npx", ["tsx", "src/db/reset.ts"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
