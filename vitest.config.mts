import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Every test database is an in-memory PGlite (src/db/test-db.ts); the app
    // singleton (getDb() without an override) is in-memory too. DATABASE_URL is
    // forced empty so a test run can never reach a remote database.
    env: {
      PGLITE_DATA_DIR: ":memory:",
      DATABASE_URL: "",
      DIRECT_URL: "",
      SESSION_SECRET: "test-secret-test-secret-test-secret-test-secret",
    },
    setupFiles: ["./src/db/test-setup.ts"],
    // PGlite boots per test (~0.3 s) and the first one per worker applies the migrations.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each worker runs its own in-memory PGlite (WASM, ~100 MB); at the default parallelism the workers
    // crash under memory pressure whenever `npm run dev` is running beside the suite. Three is safe.
    maxWorkers: 3,
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
