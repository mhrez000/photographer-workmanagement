/**
 * Database client — Postgres through Drizzle, two drivers, opened LAZILY.
 *
 *   DATABASE_URL set   → postgres-js (production: Supabase transaction pooler,
 *                         port 6543 → prepare:false). int8/numeric parse to number.
 *   DATABASE_URL unset → PGlite (in-process Postgres 17, WASM) for local dev,
 *                         unit tests and local e2e. Data dir: PGLITE_DATA_DIR
 *                         (default ./data/pglite; ":memory:" → in-memory). The
 *                         committed ./drizzle migrations (schema + the integrity
 *                         triggers in 0001_guards.sql) are applied automatically
 *                         on first open, so a fresh checkout's `npm run dev` works.
 *
 * Nothing connects at import time (`next build` never opens a database):
 * the first `getDb()` call creates the singleton (cached on globalThis so
 * Next.js dev HMR reuses it).
 *
 * EVERYTHING IS ASYNC: `await db.select()…`, `await db.transaction(async (tx) => …)`.
 * See docs/POSTGRES-MIGRATION.md for the conversion rules.
 *
 * PGlite is ONE connection: a query on the root `db` issued while a
 * transaction callback is running would wait for that transaction forever.
 * On PGlite the root handle therefore throws `RootDbInTransactionError`
 * instead of deadlocking (detected with AsyncLocalStorage) — inside a
 * transaction always use the `tx` you were given.
 *
 * Components never import this module (CLAUDE.md rule 6); services and
 * queries do. Tests use `makeTestDb()` (src/db/test-db.ts) + `setDbOverride`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { PGlite, types as pgliteTypes } from "@electric-sql/pglite";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/* ------------------------------------------------------------------ */
/*  Shared types (both drivers satisfy them)                           */
/* ------------------------------------------------------------------ */

export type Schema = typeof schema;
/** The root database handle (PGlite or postgres-js). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** The transaction handle services receive (`db.transaction(async (tx) => …)`). */
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/**
 * Anything you can run Drizzle queries on: the root `Db` or a `Tx`.
 * Read helpers (loaders, queries) accept this; writes take a `Tx`.
 */
export type DbLike = Db | Tx;

/* ------------------------------------------------------------------ */
/*  Row helpers (replace SQLite `.get()`)                              */
/* ------------------------------------------------------------------ */

/**
 * First row of a query, or undefined — the replacement for `.get()`.
 * `first(q)` does not add a LIMIT: add `.limit(1)` yourself when the WHERE
 * is not on a primary key / unique column.
 *
 *   const job = await first(tx.select().from(jobs).where(eq(jobs.id, id)));
 */
export async function first<T>(query: PromiseLike<readonly T[]>): Promise<T | undefined> {
  const rows = await query;
  return rows[0];
}

/**
 * Exactly the first row; throws a plain Error when the query returned none
 * (a programming error — use loaders / NotFoundError for user-supplied ids).
 *
 *   const { n } = await one(tx.update(organisations).set(…).returning({ n: … }));
 */
export async function one<T>(query: PromiseLike<readonly T[]>, what = "row"): Promise<T> {
  const rows = await query;
  if (rows.length === 0) throw new Error(`one(): expected a ${what}, the query returned none`);
  return rows[0];
}

/**
 * Runs raw SQL and returns its rows on BOTH drivers (`db.execute()` returns an
 * array on postgres-js but `{ rows }` on PGlite — never touch it directly).
 * Raw SQL bypasses Drizzle's column mapping: you get snake_case keys and raw
 * driver values (jsonb parsed, int8/numeric as number, booleans as booleans).
 *
 *   const rows = await execRows<{ n: number }>(tx, sql`select count(*)::int as n from jobs`);
 */
export async function execRows<T extends Record<string, unknown>>(db: DbLike, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export const DEFAULT_PGLITE_DATA_DIR = "./data/pglite";
export const MIGRATIONS_FOLDER = "./drizzle";

/** Absolute path of the committed drizzle migrations folder. */
export function migrationsFolder(): string {
  const raw = process.env.DRIZZLE_MIGRATIONS_DIR?.trim() || MIGRATIONS_FOLDER;
  return path.isAbsolute(raw) ? raw : path.resolve(/*turbopackIgnore: true*/ process.cwd(), raw);
}

/** PGlite data dir: "memory://" for PGLITE_DATA_DIR=":memory:", else an absolute path. */
export function resolvePgliteDataDir(): string {
  const raw = process.env.PGLITE_DATA_DIR?.trim() || DEFAULT_PGLITE_DATA_DIR;
  if (raw === ":memory:" || raw.startsWith("memory://")) return "memory://";
  // Runtime config, not a bundled asset: keep Turbopack from tracing the project.
  return path.isAbsolute(raw) ? raw : path.resolve(/*turbopackIgnore: true*/ process.cwd(), raw);
}

/** Which driver `getDb()` uses for the current environment. */
export function activeDriver(): "postgres" | "pglite" {
  return process.env.DATABASE_URL?.trim() ? "postgres" : "pglite";
}

/* ------------------------------------------------------------------ */
/*  Root-db-inside-a-transaction guard (PGlite deadlock → error)       */
/* ------------------------------------------------------------------ */

export class RootDbInTransactionError extends Error {
  constructor(entry: string) {
    super(
      `db.${entry}() was called on the ROOT database while a transaction callback is running. ` +
        "Use the `tx` handle you were given (on PGlite this would deadlock; on Postgres it reads outside the transaction).",
    );
    this.name = "RootDbInTransactionError";
  }
}

const txScope = new AsyncLocalStorage<boolean>();

/** True while the current async context is inside a guarded `db.transaction` callback. */
export function insideTransaction(): boolean {
  return txScope.getStore() === true;
}

const GUARDED_ENTRIES: ReadonlySet<PropertyKey> = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "insert",
  "update",
  "delete",
  "execute",
  "with",
  "$with",
  "$count",
  "refreshMaterializedView",
]);

/**
 * Wraps a root Drizzle handle so that (a) `transaction()` marks its callback's
 * async context and (b) every query entry point on the ROOT handle throws
 * `RootDbInTransactionError` from inside such a callback. The `tx` handle
 * itself is never wrapped. Used for PGlite (app + tests).
 */
export function guardRootDb<T extends Db>(db: T): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        const original = target.transaction.bind(target);
        const wrapped: Db["transaction"] = (fn, config) => {
          if (insideTransaction()) throw new RootDbInTransactionError("transaction");
          return txScope.run(true, () => original(fn, config));
        };
        return wrapped;
      }
      if (prop === "query" && insideTransaction()) throw new RootDbInTransactionError("query");
      const value: unknown = Reflect.get(target, prop, receiver);
      if (GUARDED_ENTRIES.has(prop) && typeof value === "function") {
        return (...args: unknown[]) => {
          if (insideTransaction()) throw new RootDbInTransactionError(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Drivers                                                            */
/* ------------------------------------------------------------------ */

/** int8 / numeric come back as JS numbers on BOTH drivers (count(), sum(), bigint ids). */
const toNumber = (value: string): number => Number(value);

/** PGlite parser overrides shared by the app instance and test clones. */
export const PGLITE_PARSERS = {
  [pgliteTypes.INT8]: toNumber,
  [pgliteTypes.NUMERIC]: toNumber,
};

/** postgres-js client for DATABASE_URL (Supabase transaction pooler → prepare:false). */
export function createPostgresClient(url: string, opts: { max?: number } = {}): postgres.Sql {
  return postgres(url, {
    prepare: false,
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 15,
    types: {
      int8: { to: 20, from: [20], serialize: (v: number) => String(v), parse: toNumber },
      numeric: { to: 1700, from: [1700], serialize: (v: number) => String(v), parse: toNumber },
    },
  });
}

/** Drizzle over postgres-js. */
export function createPostgresDb(url: string, opts: { max?: number } = {}): { db: Db; client: postgres.Sql } {
  const client = createPostgresClient(url, opts);
  return { db: drizzlePostgres(client, { schema }), client };
}

/** Applies the committed ./drizzle migrations to a PGlite instance (idempotent). */
export async function migratePgliteClient(client: PGlite): Promise<void> {
  await migratePglite(drizzlePglite(client, { schema }), { migrationsFolder: migrationsFolder() });
}

/**
 * A PGlite client whose query entry points first await `ready` (the auto
 * migration), so the app can be handed a Drizzle instance synchronously.
 */
function deferUntilReady(client: PGlite, ready: Promise<void>): PGlite {
  const deferred: ReadonlySet<PropertyKey> = new Set(["query", "exec", "sql", "transaction"]);
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const bound = (value as (...a: unknown[]) => unknown).bind(target);
      if (!deferred.has(prop)) return bound;
      return async (...args: unknown[]) => {
        await ready;
        return bound(...args);
      };
    },
  });
}

export interface PgliteHandle {
  db: Db;
  client: PGlite;
  /** Resolves once migrations are applied. */
  ready: Promise<void>;
}

/** Opens PGlite at `dataDir` and starts applying migrations (queries wait for them). */
export function openPglite(dataDir: string = resolvePgliteDataDir()): PgliteHandle {
  const client = new PGlite(dataDir, { parsers: PGLITE_PARSERS });
  const ready = migratePgliteClient(client);
  // Keep an unhandled rejection from crashing the process; queries rethrow it.
  ready.catch(() => undefined);
  const db = guardRootDb(drizzlePglite(deferUntilReady(client, ready), { schema }) as unknown as Db);
  return { db, client, ready };
}

/* ------------------------------------------------------------------ */
/*  Process-wide singleton (lazy; survives Next.js dev HMR)            */
/* ------------------------------------------------------------------ */

interface DbHandle {
  driver: "postgres" | "pglite";
  db: Db;
  close: () => Promise<void>;
  ready: Promise<void>;
}

const globalForDb = globalThis as unknown as { __pwmDb?: DbHandle };

function openDefault(): DbHandle {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { db, client } = createPostgresDb(url);
    return { driver: "postgres", db, close: () => client.end({ timeout: 5 }), ready: Promise.resolve() };
  }
  const handle = openPglite();
  return { driver: "pglite", db: handle.db, close: () => handle.client.close(), ready: handle.ready };
}

function handle(): DbHandle {
  globalForDb.__pwmDb ??= openDefault();
  return globalForDb.__pwmDb;
}

/* ------------------------------------------------------------------ */
/*  Injection point                                                    */
/*                                                                     */
/*  Convention: every service mutation is                               */
/*    `async fn(tx: Tx, ctx: AuthContext, input: unknown)`              */
/*  and route handlers / server actions wrap it with                    */
/*  `await withTx((tx) => fn(tx, ctx, input))` (services/_shared.ts).   */
/*  Read helpers take `DbLike` (a Db or a Tx). Code that has no db/tx  */
/*  parameter (session, layout, route glue) calls `getDb()`, which      */
/*  tests can redirect with `setDbOverride(testDb)`.                    */
/* ------------------------------------------------------------------ */

let dbOverride: Db | null = null;

/** The Drizzle instance to use when none is passed explicitly (opens it on first use). */
export function getDb(): Db {
  return dbOverride ?? handle().db;
}

/** Resolves when the default database is open and migrated (scripts await it). */
export async function dbReady(): Promise<void> {
  if (dbOverride) return;
  await handle().ready;
}

/** Closes the default database (scripts call this before exiting). No-op when never opened. */
export async function closeDb(): Promise<void> {
  const h = globalForDb.__pwmDb;
  if (!h) return;
  globalForDb.__pwmDb = undefined;
  await h.close();
}

/** Tests only: route `getDb()` to another database (pass null to restore). */
export function setDbOverride(next: Db | null): void {
  dbOverride = next;
}

export { schema };
