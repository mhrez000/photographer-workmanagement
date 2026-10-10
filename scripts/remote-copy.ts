/**
 * Generic table copier: every app table of a source database (any Drizzle
 * `DbLike`, normally a freshly seeded in-memory PGlite) → a target Postgres
 * (postgres-js client on DIRECT_URL), inside ONE target transaction.
 *
 *   - `SET LOCAL session_replication_role = replica` → user triggers (the
 *     integrity guards, incl. the TRUNCATE guards) and FK triggers do not
 *     fire while loading historical rows; it ends with the transaction
 *   - refuses when any target table already has rows, unless `wipe` — then
 *     ONE `TRUNCATE … ` of all app tables runs first, in the same transaction
 *   - FK-safe table order (TABLE_NAMES), batched multi-row inserts via
 *     `jsonb_populate_recordset(NULL::<table>, $1::text::jsonb)` so Postgres
 *     converts every column by its declared type (jsonb, boolean, numbers)
 *   - identity sequences (`rowid` columns) are advanced past the copied values
 *
 * Any error rolls the whole copy back.
 */
import { sql as dsql } from "drizzle-orm";
import type postgres from "postgres";
import { execRows, type DbLike } from "../src/db/index";
import { TABLE_NAMES, type TableName } from "../src/db/schema";

export interface CopyOptions {
  wipe?: boolean;
  batchSize?: number;
  log?: (line: string) => void;
}

export interface CopyResult {
  tables: { table: TableName; rows: number }[];
  totalRows: number;
  wiped: boolean;
}

export class TargetNotEmptyError extends Error {
  constructor(readonly nonEmpty: TableName[]) {
    super(`target database already contains rows in: ${nonEmpty.join(", ")} — pass --wipe to replace them`);
    this.name = "TargetNotEmptyError";
  }
}

/** Tables with an identity `rowid` column (insertion order). */
const IDENTITY_TABLES: readonly TableName[] = ["activity_events", "job_assignments", "automation_runs"];

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Row ordering for a deterministic copy (identity order where it exists). */
function orderFor(table: TableName): string {
  return IDENTITY_TABLES.includes(table) ? "rowid" : table === "organisation_settings" ? "organisation_id" : "id";
}

/** Which app tables of the target already contain rows. */
export async function nonEmptyTables(target: postgres.Sql | postgres.TransactionSql): Promise<TableName[]> {
  const out: TableName[] = [];
  for (const table of TABLE_NAMES) {
    const rows = await target.unsafe<{ has: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM ${quoteIdent(table)}) AS has`);
    if (rows[0]?.has) out.push(table);
  }
  return out;
}

/** Exact row count of every app table on the target (TABLE_NAMES order). */
export async function tableCounts(target: postgres.Sql): Promise<Map<TableName, number>> {
  const out = new Map<TableName, number>();
  for (const table of TABLE_NAMES) {
    const rows = await target.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`);
    out.set(table, rows[0]?.n ?? 0);
  }
  return out;
}

/** Throws a readable error when the target has not been migrated yet. */
export async function assertSchema(target: postgres.Sql): Promise<void> {
  const rows = await target.unsafe<{ name: string }[]>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const present = new Set(rows.map((r) => r.name));
  const missing = TABLE_NAMES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(`target schema is missing ${missing.length} table(s) (${missing.slice(0, 5).join(", ")}…) — run npm run db:migrate:remote first`);
  }
}

export async function copyDatabase(source: DbLike, target: postgres.Sql, options: CopyOptions = {}): Promise<CopyResult> {
  const log = options.log ?? (() => undefined);
  const batchSize = options.batchSize ?? 500;
  await assertSchema(target);

  // Read everything first (the source is local and small); the remote transaction stays short.
  const data = new Map<TableName, Record<string, unknown>[]>();
  for (const table of TABLE_NAMES) {
    const rows = await execRows<Record<string, unknown>>(
      source,
      dsql.raw(`SELECT * FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(orderFor(table))}`),
    );
    data.set(table, rows);
  }

  const result: CopyResult = { tables: [], totalRows: 0, wiped: false };
  await target.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = replica");
    const nonEmpty = await nonEmptyTables(tx);
    if (nonEmpty.length > 0) {
      if (!options.wipe) throw new TargetNotEmptyError(nonEmpty);
      await tx.unsafe(`TRUNCATE ${TABLE_NAMES.map(quoteIdent).join(", ")} RESTART IDENTITY`);
      result.wiped = true;
      log(`wiped ${nonEmpty.length} non-empty table(s)`);
    }
    for (const table of TABLE_NAMES) {
      const rows = data.get(table) ?? [];
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        // `$1::text::jsonb`, not `$1::jsonb`: postgres-js would infer jsonb for
        // the parameter and JSON-encode the (already stringified) batch a second
        // time → "cannot call jsonb_populate_recordset on a non-array".
        await tx.unsafe(
          `INSERT INTO ${quoteIdent(table)} SELECT * FROM jsonb_populate_recordset(NULL::${quoteIdent(table)}, $1::text::jsonb)`,
          [JSON.stringify(batch)],
        );
      }
      result.tables.push({ table, rows: rows.length });
      result.totalRows += rows.length;
      if (rows.length > 0) log(`  ${table}: ${rows.length}`);
    }
    for (const table of IDENTITY_TABLES) {
      await tx.unsafe(
        `SELECT setval(pg_get_serial_sequence('${table}', 'rowid'), COALESCE((SELECT MAX(rowid) FROM ${quoteIdent(table)}), 0) + 1, false)`,
      );
    }
  });
  return result;
}
