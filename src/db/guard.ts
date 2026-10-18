/**
 * DB-level integrity guards — thin view over the custom migrations
 * `drizzle/0001_guards.sql`, `drizzle/0003_roles_v2_data.sql` (roles v2:
 * users_keep_admin, users_client_link, org_primary_owner) and
 * `drizzle/0005_front_door.sql` (auth_tokens: at_no_delete, at_fill_once), which are the
 * SINGLE source of truth (PL/pgSQL functions + triggers, applied by every
 * migrate: PGlite auto-migrate, makeTestDb(), `npm run db:migrate`,
 * `npm run db:migrate:remote`).
 *
 * Layers of protection (ARCHITECTURE.md §5.4):
 *   1. append-only ledgers: activity_events (no UPDATE, no DELETE at all)
 *   2. fill-once ledgers: only the designated "close" columns may change,
 *      exactly once, from NULL
 *   3. no hard deletes of jobs / users (cancel / deactivate instead)
 *   4. jobs consistency: status belongs to the job's workflow, status_category
 *      matches the status, client matches the project, and every status_id
 *      change must already have its open job_status_transitions row
 *   5. (Postgres only) no TRUNCATE of the guarded tables
 *
 * This module only parses the migration (names/tables) and inspects a live
 * database; it never installs anything. App code does not import it.
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { execRows, type DbLike } from "./index";

/** Custom migrations that install guard triggers, in apply order. */
export const GUARD_MIGRATION_FILES = ["0001_guards.sql", "0003_roles_v2_data.sql", "0005_front_door.sql"] as const;
/** @deprecated use GUARD_MIGRATION_FILES (roles v2 and the front door added further guards files). */
export const GUARD_MIGRATION_FILE = GUARD_MIGRATION_FILES[0];

export interface GuardDefinition {
  /** Trigger name (unique per table in Postgres; unique overall here). */
  name: string;
  table: string;
  /** "row" = the 33 row-level guards (28 ported from SQLite + 3 roles v2 + 2 auth_tokens); "truncate" = statement-level TRUNCATE guards. */
  level: "row" | "truncate";
}

/** Path of a guards migration (DRIZZLE_MIGRATIONS_DIR or ./drizzle); default the first one. */
export function guardMigrationPath(file: string = GUARD_MIGRATION_FILES[0]): string {
  const dir = process.env.DRIZZLE_MIGRATIONS_DIR?.trim() || "drizzle";
  return path.resolve(process.cwd(), dir, file);
}

/** Every guard migration's SQL text, concatenated in apply order. */
export function guardSql(): string {
  return GUARD_MIGRATION_FILES.map((f) => fs.readFileSync(guardMigrationPath(f), "utf8")).join(String.fromCharCode(10));
}

/** Every trigger the guards migration creates, in file order. */
export function parseGuards(text: string = guardSql()): GuardDefinition[] {
  const out: GuardDefinition[] = [];
  const re = /CREATE TRIGGER\s+(\w+)\s+BEFORE\s+(TRUNCATE|INSERT|UPDATE|DELETE)\b[^;]*?\bON\s+(\w+)/gi;
  for (const m of text.matchAll(re)) {
    out.push({ name: m[1], table: m[3], level: m[2].toUpperCase() === "TRUNCATE" ? "truncate" : "row" });
  }
  return out;
}

/** All guard triggers (33 row-level + the TRUNCATE guards). */
export const GUARDS: readonly GuardDefinition[] = parseGuards();

/** The 33 row-level integrity rules (28 from the former SQLite triggers + 3 roles v2 user/org guards + 2 auth_tokens guards). */
export const ROW_GUARDS: readonly GuardDefinition[] = GUARDS.filter((g) => g.level === "row");

/** Tables that carry at least one guard. */
export const GUARDED_TABLES: readonly string[] = Array.from(new Set(GUARDS.map((g) => g.table)));

/** Names of the guard triggers currently installed in the database (sorted). */
export async function listInstalledGuards(db: DbLike): Promise<string[]> {
  const known = new Set(GUARDS.map((g) => g.name));
  const rows = await execRows<{ name: string }>(
    db,
    sql`SELECT t.tgname AS name FROM pg_trigger t WHERE NOT t.tgisinternal ORDER BY t.tgname`,
  );
  return rows.map((r) => r.name).filter((n) => known.has(n));
}
