// Production-mode check against the remote database from a workstation:
//
//   npx next build
//   node scripts/start-remote.mjs [port]      (default port 3160)
//
// Loads DATABASE_URL (transaction pooler) and DIRECT_URL from .env.supabase —
// or from the file named by REMOTE_ENV_FILE, e.g. a local rehearsal server —
// into the child process env ONLY, then runs `next start`. Next itself never
// auto-loads .env.supabase. Connection strings are never printed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const fileName = process.env.REMOTE_ENV_FILE?.trim() || ".env.supabase";
const file = path.resolve(process.cwd(), fileName);
if (!fs.existsSync(file)) {
  process.stderr.write(`start-remote: ${fileName} not found in ${process.cwd()}\n`);
  process.exit(2);
}
const parsed = parse(fs.readFileSync(file));
if (!parsed.DATABASE_URL?.trim()) {
  process.stderr.write(`start-remote: ${fileName} does not define DATABASE_URL\n`);
  process.exit(2);
}

const port = process.argv[2] ?? "3160";
let host = "<unparseable>";
try {
  const u = new URL(parsed.DATABASE_URL);
  host = `${u.hostname}:${u.port || "5432"}`;
} catch {
  // keep placeholder; the URL itself is never printed
}
process.stdout.write(`start-remote: next start -p ${port} → DATABASE_URL from ${fileName} (${host})\n`);

const env = { ...process.env, DATABASE_URL: parsed.DATABASE_URL, NODE_ENV: "production" };
if (parsed.DIRECT_URL) env.DIRECT_URL = parsed.DIRECT_URL;
delete env.PGLITE_DATA_DIR;

const child =
  process.platform === "win32"
    ? spawn(`npx next start -p ${Number(port)}`, { stdio: "inherit", env, shell: true })
    : spawn("npx", ["next", "start", "-p", String(Number(port))], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
