# Postgres migration playbook (SQLite → Postgres, sync → async)

**Status: contract for the whole migration.** Every agent converting a module follows this file. If something here is wrong, fix it here in the same change.

Behaviour, API contracts, UI and test intent do **not** change — only the storage engine. The data rules survive unchanged: append-only `activity_events`; fill-once ledger columns; no hard deletes of jobs/users; the jobs consistency triggers; org isolation; optimistic versioning; every mutation + its audit event in ONE transaction.

---

## 0. What the foundation already did

| Area | Where | Notes |
|---|---|---|
| Schema | `src/db/schema.ts` (`drizzle-orm/pg-core`) | Same table/column/relation/TS names. `boolean()`, `jsonb().$type<T>()`, `doublePrecision()`, `integer()`, timestamps stay ISO-8601 **text**. New column **`rowid`** (bigint identity, insertion order) on `activity_events`, `job_assignments`, `automation_runs` — replaces SQLite's implicit rowid. |
| Migrations | `drizzle/0000_init.sql` (generated), `drizzle/0001_guards.sql` (custom) | The guards migration is the single source of truth for the 28 integrity triggers (+ 12 Postgres-only `BEFORE TRUNCATE` guards). Same messages as before. `src/db/guard.ts` only parses it / lists installed triggers. |
| Client | `src/db/index.ts` | Lazy dual driver: `DATABASE_URL` → postgres-js (Supabase pooler, `prepare:false`); unset → PGlite (`PGLITE_DATA_DIR`, default `./data/pglite`, auto-migrates on first open). |
| Tests | `src/db/test-db.ts`, `src/db/test-setup.ts`, `vitest.config.mts` | `await makeTestDb()` = fresh in-memory PGlite cloned from a migrated template (~0.3 s). Closed automatically after each test. |
| Kernel (async) | `services/_shared.ts`, `audit.ts`, `services/notifications.ts`, `services/automationTriggers.ts`, `auth/session.ts`, `page.ts`, `db/verify.ts`, `cron.ts`, `api/system/integrity` | Done; their tests pass on PGlite. |
| Scripts | `package.json`, `scripts/*` | `db:migrate`, `db:seed`, `db:reset`, `db:verify` (local PGlite) and `db:migrate:remote`, `db:seed:remote [-- --wipe]`, `db:verify:remote` (Supabase via `.env.supabase`). `vercel-build` migrates when `DIRECT_URL` is set. |

---

## 1. The API you code against

```ts
import { first, one, execRows, getDb, type Db, type Tx, type DbLike } from "@/db/index";
import { withTx, withTxThenAutomations, afterCommit, runAutomationsAfterCommit, parseInput, assertVersion, loadJobInOrg /* … */ } from "@/server/services/_shared";
import { pgError, rootErrorMessage, isUniqueViolation, isGuardViolation, PG_CODES } from "@/db/errors";
```

| Helper | Signature | Use |
|---|---|---|
| `Db` / `Tx` / `DbLike` | `PgDatabase<PgQueryResultHKT, Schema>` / its `PgTransaction` / `Db \| Tx` | Both drivers satisfy them. Reads take `DbLike`, mutations take `Tx`. |
| `first(q)` | `<T>(q: PromiseLike<readonly T[]>) => Promise<T \| undefined>` | Replaces `.get()`. Does **not** add `LIMIT` — add `.limit(1)` when the WHERE is not a PK/unique lookup. |
| `one(q, what?)` | `<T>(q) => Promise<T>`; throws when empty | Replaces `.get()!` / `.returning().get()` when a row must exist. |
| `execRows<T>(db, sql)` | `Promise<T[]>` | Raw SQL on both drivers (`db.execute()` returns an array on postgres-js but `{rows}` on PGlite — never use it directly). snake_case keys, raw values. |
| `withTx(fn, { db?, isolationLevel? })` | `async (fn: (tx) => Promise<T> \| T) => Promise<T>` | One `BEGIN…COMMIT`; rollback when `fn` throws. |
| `withTxThenAutomations(ctx, fn, opts?)` | `Promise<T>` | `withTx` + `await runAutomationsAfterCommit`. |
| `afterCommit(tx, hook)` | `void` | Runs `hook` after COMMIT of a `withTx` transaction, never after rollback. Replaces "setImmediate because transactions are sync". |
| `withSavepoint(tx, fn)` | `Promise<T>` | `tx.transaction(async (sp) => …)` (a SAVEPOINT) that keeps `afterCommit` working inside it: hooks registered on `sp` join the outer `withTx` hooks on release and are dropped on rollback. Use it instead of a bare `tx.transaction` whenever the savepoint body may call `notify()` (e.g. automation actions). |
| `runAutomationsAfterCommit(db, orgId)` | `Promise<void>`, never throws | Post-commit automation runner. |
| loaders `loadJobInOrg(db, ctx, id)` … | all `Promise<Row>` | Unchanged semantics (404 for missing/foreign). |
| `buildContextFromDb(db, userId, opts)` | `Promise<AuthContext \| null>` | |
| `systemContext(orgId, { db: tx, … })` | `Promise<AuthContext>` | Reads org settings → **inside a transaction always pass `db: tx`**. |
| `loadTeamUserIds(db, org, user)` | `Promise<Set<string>>` | |
| `recordEvent(tx, ctx, input)` / `recordEvents` | `Promise<string>` / `Promise<string[]>` | Same contract; `last_activity_at` bump is now `GREATEST(...)`. |
| `enqueueAutomations(tx, ctx, event)` | `Promise<string[]>` | Called by `recordEvent`. |
| `notify(tx, ctx, input)` | `Promise<NotifyResult>` | External channels dispatched via `afterCommit`. `managersOf/ownersOf/jobParticipants/unreadCount` are async. |
| `verifyDerived(db, orgId?)` | `Promise<IntegrityReport>` | Takes a Drizzle handle (not a raw client). Root `Db` → own REPEATABLE READ read-only tx; `Tx` → runs inside it. |
| `load(fn)` (pages) | `Promise<T>` | `const x = await load(() => query(db, ctx, …))`. |
| `pgError(err)` / `rootErrorMessage(err)` / `isUniqueViolation(err, constraint?)` / `isGuardViolation(err)` | | Drizzle wraps DB errors as `DrizzleQueryError("Failed query: …")`; the Postgres error (SQLSTATE `code`, trigger message) is on `.cause`. Never match `err.message` of a DB error. |
| `RootDbInTransactionError` | | Thrown (PGlite only) when the ROOT db is queried from inside a transaction callback — it would deadlock PGlite's single connection. Fix the code: use the `tx`. |

Test helpers (`src/db/test-db.ts`): `makeTestDb(): Promise<TestDb>`, `seedMinimalOrg(db, opts?): Promise<SeedIds>`, `addTeamFixture(db, ids, opts): Promise<{teamId, membershipIds}>`, `insertJobFixture(db, ids, opts?): Promise<JobFixture>`, `insertDefaultWorkflow(db, orgId, opts?)`, `contextFor(db, userId, opts?): Promise<AuthContext>`, `systemContextFor(db, orgId, opts?): Promise<AuthContext>`, `dbRejection(promise): Promise<string>` (Postgres message of an expected DB rejection), `fakeClock` (unchanged), `TEST_PASSWORD`, `testPasswordHash()`. `TestDb = Db & { $client: PGlite }`.

---

## 2. Async conversion rules

1. **Every query is awaited.** Builders are thenables:
   - `.all()` → `await q` (returns the array)
   - `.get()` → `await first(q)` (or `const [row] = await q.limit(1)`)
   - `.run()` → `await q`
   - `.run().changes` → `(await q.returning({ id: t.id })).length`
   - `.returning().get()` → `await one(q.returning())` / `const [row] = await q.returning()`
   - `.returning().all()` → `await q.returning()`
2. **Transactions:** `db.transaction((tx) => …)` (sync) → `await db.transaction(async (tx) => …)`; services use `await withTx(async (tx) => …)`. Nested `tx.transaction(async (sp) => …)` is a **SAVEPOINT**.
3. **Every service / query / loader returns a Promise; every caller awaits.** Signature: `export async function fooService(tx: Tx, ctx: AuthContext, input: unknown): Promise<R>`.
4. **Never `forEach(async …)` / `map(async …)` without awaiting.** Use `for (const x of xs) { await … }`. Order of writes is part of the ledger contract.
5. **`Promise.all` only for independent READS on the root `db` outside a transaction.** Inside a transaction everything is sequential (one connection).
6. **Inside a transaction callback, never touch the root db** (`getDb()`, the test `db`, `systemContext(org)` without `db: tx`, helpers that default to `getDb()`). On PGlite this throws `RootDbInTransactionError`; on Postgres it would read outside the transaction. Compute anything you need from the root db (e.g. a test's `expectedVersion`) **before** opening the transaction.
7. **A failed statement aborts the Postgres transaction.** SQLite let you catch a constraint error and continue; Postgres does not ("current transaction is aborted"). If you catch a DB error and carry on in the same transaction, wrap the statement in a savepoint: `try { await tx.transaction(async (sp) => sp.insert(…)) } catch (err) { if (!isUniqueViolation(err)) throw err; }`. Prefer `onConflictDoNothing()` / pre-checks.
8. **Post-commit work** (automations, external notification delivery) runs after `withTx` resolves or via `afterCommit(tx, hook)`. Never `setImmediate` "because the tx has committed by then" — it has not.
9. **No sync DB access remains.** `better-sqlite3`, `db.$client.prepare`, `sqlite.pragma`, `sqlite.transaction(...)` are gone. Raw SQL: `await execRows<T>(db, sql\`…\`)`. Imports from `drizzle-orm/sqlite-core` (`alias`, `AnySQLiteColumn`, `SQLiteSyncDialect`, `SQLiteColumn`…) become `drizzle-orm/pg-core` (`alias`, `AnyPgColumn`, `PgDialect`, `PgColumn`).
10. Empty `values([])` throws in Drizzle — guard empty arrays before multi-row inserts. `inArray(col, [])` is fine (renders `false`).
11. Concurrency: default isolation is READ COMMITTED. Optimistic versioning keeps working (`UPDATE … WHERE id = ? AND version = ? RETURNING` → 0 rows → 409). `UPDATE organisations SET job_sequence = job_sequence + 1 … RETURNING` row-locks → gap-free numbers. Do not add `SERIALIZABLE` without a retry loop.

---

## 3. SQLite → Postgres SQL rules

| SQLite | Postgres | Notes |
|---|---|---|
| `LIKE` (ASCII case-insensitive) | `ilike(col, pattern)` / `ILIKE` | Postgres `LIKE` is case-SENSITIVE. Every search / filter `like()` becomes `ilike()`. `ESCAPE '\'` still works (backslash is already the default escape). |
| `col = 1` / `= 0` on booleans | `eq(col, true)` / `= true` / `IS TRUE` | Booleans are real booleans. Raw SELECTs return JS booleans, not 0/1. Partial-index predicates already use `= true`. |
| `json_extract(m, '$.a')` | `m->>'a'` (text) / `m->'a'` (jsonb) | `->>` yields **text**: cast for numbers `(m->>'n')::int`. Equality with a param: `m->>'transitionId' = ${id}`. Key presence: `m ? 'key'`. Containment: `m @> ${JSON.stringify(x)}::jsonb`. |
| `json_each(m, '$.arr')` | `jsonb_array_elements(m->'arr')` / `jsonb_array_elements_text(…)` | Use `CROSS JOIN LATERAL jsonb_array_elements(…) AS o(value)`; guard non-arrays with `jsonb_typeof(…) = 'array'`. |
| jsonb key order | — | jsonb normalises key order and drops duplicate keys. Compare parsed objects (`toEqual`), never `JSON.stringify` output. |
| `datetime()`, `julianday()`, `strftime()` | `::timestamptz`, `EXTRACT(EPOCH FROM (a::timestamptz - b::timestamptz))`, `to_char(…)` | **Timestamps stay ISO-8601 TEXT.** Compare as text (same fixed format, lexical = chronological). Cast with `::timestamptz` only where date math is needed. Prefer doing date math in TS (`src/lib/dates.ts`). |
| `IFNULL(a, b)` | `COALESCE(a, b)` | |
| `GROUP_CONCAT` | `string_agg(x, ',')` / `array_agg` | |
| `CAST(x AS REAL)` | `x::double precision` | Postgres `real` is float4 — never cast to `real`. |
| `col COLLATE NOCASE` (ORDER BY) | `lower(col)` (+ the original as a tiebreak) | `src/server/queries/jobs.ts` and `search.ts` use `collate nocase`. |
| `rowid` | the `rowid` column (3 tables) / `id` | `activity_events`, `job_assignments`, `automation_runs` have a real `rowid` identity column, so `ORDER BY created_at, rowid` keeps working — qualify it in joins (`"activity_events"."rowid"`). Other tables have no rowid: tie-break on `id`. |
| implicit row order | explicit `ORDER BY` | SQLite usually returned rowid / index order; Postgres guarantees nothing. **Add ORDER BY wherever the caller or a test depends on order.** |
| NULL ordering | `NULLS FIRST` / `NULLS LAST` | SQLite: NULLs first in ASC, last in DESC. Postgres: NULLs **last** in ASC, **first** in DESC. Use `asc(col)` + `sql\`${col} asc nulls first\`` where the old order mattered. |
| text ORDER BY | `lower()` / `COLLATE "C"` | SQLite BINARY = byte order. PGlite uses C collation (same as SQLite); Supabase uses a linguistic collation. Where a test or UI depends on exact order, use explicit `lower()` or `COLLATE "C"`. |
| lax GROUP BY | strict GROUP BY | Every non-aggregated SELECT column must be in GROUP BY (or be functionally dependent on a grouped PK). |
| alias in WHERE / HAVING | repeat the expression | Postgres allows SELECT aliases only in ORDER BY / GROUP BY. |
| `SELECT DISTINCT … ORDER BY x` | x must be in the select list | Or use `DISTINCT ON` / a subquery. |
| `count(*)`, `sum()`, `avg()` types | numbers | Both drivers parse int8 and numeric to JS `number`. Drizzle's `count()` is typed number; `sum()`/`avg()` are typed `string` → use `sql<number>\`coalesce(sum(${x}), 0)\`.mapWith(Number)`. |
| untyped params | `${value}::text` | Postgres must infer each `$n` type. A bare param in a SELECT list / `COALESCE(${a}, ${b})` / `CASE … THEN ${x}` may fail with "could not determine data type of parameter" → cast. |
| `INSERT OR IGNORE` | `.onConflictDoNothing()` | With a target on a partial unique index, also pass `where`/`targetWhere` matching the index predicate. |
| `IN (…)` with booleans `0/1` | `IN (true, false)` | |
| integer division | same | `int / int` truncates in both. |
| `||`, `MAX/MIN` on text, `RETURNING`, `ON CONFLICT` | same | |

---

## 4. Test porting rules

- `beforeEach(() => { db = makeTestDb(); ids = seedMinimalOrg(db); })` → `beforeEach(async () => { db = await makeTestDb(); ids = await seedMinimalOrg(db); })`. Create DBs only in `beforeEach` or inside the test (they are closed after each test).
- `expect(() => svc()).toThrow(X)` → `await expect(svc()).rejects.toThrow(X)`; `expect(() => …).not.toThrow()` → `await expect(…).resolves…` or just `await …`.
- DB-trigger / constraint rejections: `expect(await dbRejection(db.update(…))).toMatch(/append-only/)` (Drizzle's message is "Failed query: …").
- Raw SQL tampering: `db.$client.prepare("… ?").run(a)` → `await db.$client.query("… $1", [a])`.
- `verifyDerived(db.$client)` → `await verifyDerived(db)`.
- `contextFor(db, id)` / `systemContextFor` are async: `const ctx = await contextFor(db, ids.users.manager)`.
- Inside `withTx((tx) => …, { db })` never read `db` (compute `expectedVersion` etc. first). The test `db` is root-guarded and will throw `RootDbInTransactionError`.
- Order-sensitive assertions: if the production query now has an explicit ORDER BY, keep the assertion; never "fix" a test by sorting away an ordering the product promises.
- Do not weaken or delete tests. `vitest.config.mts` gives 30 s per test / 60 s per hook.

---

## 5. Pages, routes, actions

- Pages: `const { ctx, db } = await pageContext(); guard(ctx, …); const x = await load(() => query(db, ctx, …));`
- Route handlers / actions: `return withTx((tx) => service(tx, ctx, body))` inside `handle(async …)`; read the body before (`const body = await bodyOrNull(req)`).
- Components still never import `src/db`.

---

## 6. Environments & commands

| | Driver | How |
|---|---|---|
| `npm run dev`, local e2e | PGlite file DB (`./data/pglite`, e2e: `./data/pglite-e2e`) | Auto-migrates on first open. One process per data dir: stop `next dev` before `db:reset`/`db:seed`. |
| `npm test` | PGlite in memory | `PGLITE_DATA_DIR=:memory:`, `DATABASE_URL=""` forced by vitest config. |
| Vercel (production) | postgres-js on `DATABASE_URL` (Supabase transaction pooler :6543, `prepare:false`) | `vercel-build` runs `drizzle-kit migrate` against `DIRECT_URL` first (skipped when unset). |
| Remote maintenance | postgres-js on `DIRECT_URL` (session pooler :5432) | `npm run db:migrate:remote`, `db:seed:remote [-- --wipe]`, `db:verify:remote` — load `.env.supabase` (gitignored, never auto-loaded by Next). Never print or commit its values. |

Local `.env` / `.env.local` must **never** contain `DATABASE_URL` (that would point dev/tests at Supabase). `db:reset` and `db:migrate` refuse to run when it is set.

`db:seed:remote` seeds a fresh in-memory PGlite through the real seed, then copies every table to Supabase in ONE transaction with `SET LOCAL session_replication_role = replica` (guards and FK triggers off for the load), in `TABLE_NAMES` order with batched `jsonb_populate_recordset` inserts, advances the `rowid` identity sequences, and runs verify against the remote. It refuses when any remote table has rows unless `--wipe` (then one `TRUNCATE … RESTART IDENTITY` of all app tables runs first, in the same transaction). The emptiness/schema check runs BEFORE the ~45 s local seed, and after COMMIT the script re-counts every remote table and fails unless each equals the local seed exactly. Each batch is passed as `$1::text::jsonb` — with a plain `$1::jsonb` postgres-js infers a jsonb parameter and JSON-encodes the already-stringified batch again ("cannot call jsonb_populate_recordset on a non-array").

**Rehearsing a cutover locally.** `REMOTE_ENV_FILE=<file>` makes every `*:remote` script and `scripts/start-remote.mjs` (production `next start` with `DATABASE_URL` from that file, default port 3160) read another gitignored env file instead of `.env.supabase`. Point it at a real local Postgres 17 (e.g. the `embedded-postgres` npm binaries: `initdb --encoding=UTF8 --locale=en-US`, `pg_ctl -o "-p 55432" start`) to run migrate → seed → `next build` + start → curl matrix → `E2E_BASE_URL=http://localhost:3160 npx playwright test` → `seed -- --wipe` → verify without touching Supabase. Do not use `pglite-socket` with more than one connection for this: it interleaves extended-protocol messages from concurrent connections ("bind message supplies N parameters…").

After any `schema.ts` change: `npx drizzle-kit generate` (the freshness test in `src/db/test-db.test.ts` fails until you do). Trigger changes go into a NEW custom migration (`npx drizzle-kit generate --custom --name <name>`) using `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER` — never edit an applied migration.

---

## 7. Known hotspots per module (from the SQLite code)

- `rowid`: `queries/activity.ts` (keyset cursor), `queries/jobHistory.ts`, `services/automationEngine.ts` (job_assignments, activity_events, automation_runs), `services/notes.ts`, `services/sweep.ts` — the column exists now; qualify it in joins.
- `json_extract`: `services/automationEngine.ts`.
- `collate nocase`: `queries/jobs.ts`, `queries/search.ts`.
- LIKE search helper: `queries/scope.ts` (`likeSql` / `likePattern`) → `ILIKE … ESCAPE` (done).
- `.run().changes`: `services/sweep.ts`.
- `runPendingAutomations` (automationEngine) and `runSweep` / `maybeRunSweep` / `lazySweep` (sweep) are async (done). The engine claims each run with `SELECT … FOR UPDATE` (replaces SQLite's IMMEDIATE transaction) and runs every action in `withSavepoint`.
- Seed (done): `runSeed(db, { now, log, bcryptCost? })` and `buildReport(db, organisationId, nowMs)` are async without the `sqlite` argument; `summary.ts` raw SQL goes through `execRows`. Seed steps read versions / job rows on `rt.db` BEFORE `rt.act()` opens its transaction (never inside the callback).
