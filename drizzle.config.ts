import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration (Postgres).
 *
 *   npx drizzle-kit generate            → new SQL migration in ./drizzle from src/db/schema.ts
 *   npx drizzle-kit migrate             → applies ./drizzle to DIRECT_URL (fallback DATABASE_URL)
 *
 * The integrity triggers live in the custom migration drizzle/0001_guards.sql
 * (drizzle-kit does not model triggers). Local dev/tests never use this file
 * to connect: they run on PGlite and apply ./drizzle with drizzle-orm's
 * PGlite migrator (src/db/index.ts, src/db/test-db.ts). Remote use goes
 * through `npm run db:migrate:remote`, which loads .env.supabase first.
 */
const url = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim() || "";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  // Migration bookkeeping table lives in its own schema (drizzle default).
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  strict: true,
  verbose: false,
});
