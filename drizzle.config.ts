import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration. `npm run db:push` creates/updates data/app.db
 * from src/db/schema.ts. Triggers are NOT managed here — run
 * `npm run db:guard` (or any script that opens src/db/index.ts) afterwards.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_PATH?.trim() || "./data/app.db",
  },
});
