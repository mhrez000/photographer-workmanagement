// `npm run e2e:prepare` — reset the dedicated e2e database (data/e2e.db) with
// the same reset → guard → seed pipeline as `npm run db:reset`, but never
// touching data/app.db. Cross-platform replacement for
// `DATABASE_PATH=./data/e2e.db tsx src/db/reset.ts` (cmd.exe has no inline env).
import { spawnSync } from "node:child_process";

const env = { ...process.env, DATABASE_PATH: "./data/e2e.db" };
const result = spawnSync("npx", ["tsx", "src/db/reset.ts"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
