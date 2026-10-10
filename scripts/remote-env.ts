/**
 * Loads the Supabase connection strings from .env.supabase (gitignored,
 * NEVER auto-loaded by Next.js) for the `db:*:remote` scripts.
 *
 * Values are never printed: `describeUrl()` reports host/port/database only.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";

export interface RemoteEnv {
  /** Session pooler (port 5432): migrations, bulk loads, verify. */
  directUrl: string;
  /** Transaction pooler (port 6543): runtime. */
  databaseUrl: string | null;
}

export const REMOTE_ENV_FILE = ".env.supabase";

/**
 * The env file to load: `.env.supabase` unless `REMOTE_ENV_FILE` names another
 * one (e.g. a local wire-protocol Postgres used to rehearse a cutover). Only
 * the file NAME may come from the environment, never the URLs themselves.
 */
export function remoteEnvFile(): string {
  return process.env.REMOTE_ENV_FILE?.trim() || REMOTE_ENV_FILE;
}

export function loadRemoteEnv(): RemoteEnv {
  const name = remoteEnvFile();
  const file = path.resolve(process.cwd(), name);
  if (!fs.existsSync(file)) {
    throw new Error(`${name} not found in ${process.cwd()} — it must define DIRECT_URL (and DATABASE_URL).`);
  }
  const parsed = config({ path: file, override: true, quiet: true });
  if (parsed.error) throw new Error(`${name} could not be parsed: ${parsed.error.message}`);
  const directUrl = process.env.DIRECT_URL?.trim();
  if (!directUrl) throw new Error(`${name} does not define DIRECT_URL (session pooler, port 5432).`);
  return { directUrl, databaseUrl: process.env.DATABASE_URL?.trim() || null };
}

/** "host:port/database" — safe to print (no user, no password). */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}
