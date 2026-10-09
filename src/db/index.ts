/**
 * Database client (better-sqlite3 + Drizzle).
 *
 * - DATABASE_PATH env (default ./data/app.db; ":memory:" for tests)
 * - PRAGMA journal_mode = WAL, foreign_keys = ON, busy_timeout = 5000
 * - append-only / consistency triggers are (re)installed on open whenever
 *   the tables already exist (src/db/guard.ts), so a database created by
 *   `drizzle-kit push` is protected the moment the app opens it.
 *
 * Components never import this module (CLAUDE.md rule 6); services and
 * queries do. Tests call `createDatabase(":memory:")` for an isolated DB.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { installGuards, tablesExist } from "./guard";

export type Db = BetterSQLite3Database<typeof schema>;
/** The transaction handle services receive. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/**
 * Anything you can run Drizzle queries on: the root `Db` or a `Tx`.
 * Read helpers (loaders, queries) accept this; writes take a `Tx`.
 */
export type DbLike = BaseSQLiteDatabase<"sync", Database.RunResult, typeof schema>;

export const DEFAULT_DATABASE_PATH = "./data/app.db";

/**
 * Hosted demo mode (Vercel): the deployment filesystem is read-only, so the app
 * runs on a copy of the seeded demo database in /tmp. Each new server instance
 * starts from the bundled template (data/demo.db, built by scripts/build-demo-db.mjs);
 * changes last only as long as that instance. See README "Deploying to Vercel".
 */
export const HOSTED_DEMO_DATABASE_PATH = "/tmp/proofline.db";
export const DEMO_TEMPLATE_PATH = "./data/demo.db";

function isHostedDemo(): boolean {
  return Boolean(process.env.VERCEL) && !process.env.DATABASE_PATH?.trim();
}

/** Template copied into an empty database path: DEMO_DB_TEMPLATE, or data/demo.db in hosted demo mode. */
export function resolveTemplatePath(): string | null {
  const raw = process.env.DEMO_DB_TEMPLATE?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(/*turbopackIgnore: true*/ process.cwd(), raw);
  return isHostedDemo() ? path.resolve(/*turbopackIgnore: true*/ process.cwd(), DEMO_TEMPLATE_PATH) : null;
}

export function resolveDatabasePath(): string {
  const raw = process.env.DATABASE_PATH?.trim();
  if (isHostedDemo()) return HOSTED_DEMO_DATABASE_PATH;
  if (!raw) return path.resolve(/*turbopackIgnore: true*/ process.cwd(), DEFAULT_DATABASE_PATH);
  if (raw === ":memory:") return raw;
  // DATABASE_PATH is runtime config, not a bundled asset: keep Turbopack from
  // tracing the whole project into the server output.
  return path.isAbsolute(raw) ? raw : path.resolve(/*turbopackIgnore: true*/ process.cwd(), raw);
}

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: Db;
  filePath: string;
}

/**
 * Opens (and creates if needed) a SQLite file and returns both the raw
 * better-sqlite3 handle and the Drizzle instance bound to the schema.
 */
export function createDatabase(filePath: string = resolveDatabasePath(), opts: { installGuards?: boolean } = {}): DatabaseHandle {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const template = resolveTemplatePath();
    if (template && !fs.existsSync(/*turbopackIgnore: true*/ filePath) && fs.existsSync(/*turbopackIgnore: true*/ template)) {
      // Copy to a temp name and rename, so concurrent cold starts never open a half-copied file.
      const staging = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(/*turbopackIgnore: true*/ template, staging);
      try {
        fs.renameSync(staging, filePath);
      } catch {
        fs.rmSync(staging, { force: true });
      }
    }
  }
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  if (opts.installGuards !== false && tablesExist(sqlite)) {
    installGuards(sqlite);
  }

  const db = drizzle(sqlite, { schema });
  return { sqlite, db, filePath };
}

/* ------------------------------------------------------------------ */
/*  Process-wide singleton (survives Next.js dev HMR via globalThis)    */
/* ------------------------------------------------------------------ */

const globalForDb = globalThis as unknown as { __pwmDb?: DatabaseHandle };

function getHandle(): DatabaseHandle {
  if (!globalForDb.__pwmDb) {
    globalForDb.__pwmDb = createDatabase();
  }
  return globalForDb.__pwmDb;
}

const handle = getHandle();

/** Shared Drizzle instance for the running app. */
export const db: Db = handle.db;

/** Raw better-sqlite3 handle (used by guard/verify/tests; never by components). */
export const sqlite: Database.Database = handle.sqlite;

/* ------------------------------------------------------------------ */
/*  Injection point                                                    */
/*                                                                     */
/*  Convention: every service mutation is                               */
/*    `fn(tx: Tx, ctx: AuthContext, input: unknown)`                    */
/*  and route handlers / server actions wrap it with                    */
/*  `withTx((tx) => fn(tx, ctx, input))` from services/_shared.ts.      */
/*  Read helpers take `DbLike` (a Db or a Tx). Code that has no db/tx  */
/*  parameter (session, layout, route glue) calls `getDb()`, which      */
/*  tests can redirect with `setDbOverride(testDb)`.                    */
/* ------------------------------------------------------------------ */

let dbOverride: Db | null = null;

/** The Drizzle instance to use when none is passed explicitly. */
export function getDb(): Db {
  return dbOverride ?? db;
}

/** Tests only: route `getDb()` to another database (pass null to restore). */
export function setDbOverride(next: Db | null): void {
  dbOverride = next;
}

export { schema };
